// src/app/api/admin/soniox/route.ts
// 管理 Soniox API Key 配置（加密存储）

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { encrypt, decrypt } from '@/lib/crypto';
import { invalidateSiteSettingsCache } from '@/lib/siteSettings';
import { invalidateSonioxDbConfigCache } from '@/lib/soniox/env';
import { validateCloudreveBaseUrl } from '@/lib/storage/cloudreve';

const VALID_REGIONS = ['us', 'eu', 'jp'] as const;

/**
 * 校验 Soniox REST 地址（https/http）：格式合法 + 私网过滤，防 SSRF。
 * 复用 Cloudreve 的 validateCloudreveBaseUrl（http/https + 私网黑名单）。
 * 通过则返回去掉尾部斜杠的原始地址；非法抛出 Error。
 */
function validateSonioxRestUrl(value: string): string {
  validateCloudreveBaseUrl(value);
  // 保留管理员填写的原始地址（仅去掉尾部斜杠），不强制改写为 cloudreve 的规范化形式
  return value.replace(/\/+$/, '');
}

/**
 * 校验 Soniox WebSocket 地址（wss/ws）：格式合法 + 私网过滤，防 SSRF。
 * validateCloudreveBaseUrl 仅接受 http/https，故先把 ws(s) 映射为 http(s) 复用其私网/格式校验，
 * 通过后仍返回管理员填写的原始 ws(s) 地址（仅去掉尾部斜杠）。
 */
function validateSonioxWsUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('wsUrl must be a valid URL');
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new Error('wsUrl must use ws or wss');
  }
  // 映射到 http(s) 以复用 validateCloudreveBaseUrl 的私网/格式校验（host/userinfo/port 保持不变）
  const httpEquivalent = new URL(value);
  httpEquivalent.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  validateCloudreveBaseUrl(httpEquivalent.toString());
  return value.replace(/\/+$/, '');
}

/**
 * GET /api/admin/soniox
 * 获取 Soniox 配置状态（不返回完整 API Key，仅返回是否已配置）
 */
export async function GET(req: Request) {
  const { response } = await requireAdminAccess(req, {
    scope: 'admin:soniox:get',
    limit: 60,
  });
  if (response) return response;

  try {
    const rows = await prisma.siteSetting.findMany({
      where: {
        key: {
          startsWith: 'soniox_',
        },
      },
    });

    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }

    // 构建各区域配置状态
    const regions: Record<string, {
      hasApiKey: boolean;
      maskedKey: string;
      wsUrl: string;
      restUrl: string;
    }> = {};

    for (const region of VALID_REGIONS) {
      const upper = region.toUpperCase();
      const encryptedKey = settings[`soniox_${upper}_api_key`] || '';
      let maskedKey = '';

      if (encryptedKey) {
        try {
          const realKey = decrypt(encryptedKey);
          // 只显示前 4 位和后 4 位
          if (realKey.length > 8) {
            maskedKey = realKey.slice(0, 4) + '****' + realKey.slice(-4);
          } else {
            maskedKey = '****';
          }
        } catch {
          maskedKey = '（解密失败）';
        }
      }

      regions[region] = {
        hasApiKey: !!encryptedKey,
        maskedKey,
        wsUrl: settings[`soniox_${upper}_ws_url`] || '',
        restUrl: settings[`soniox_${upper}_rest_url`] || '',
      };
    }

    return NextResponse.json({
      configured: settings.soniox_configured === 'true',
      defaultRegion: settings.soniox_default_region || 'us',
      regions,
    });
  } catch (err) {
    console.error('获取 Soniox 配置失败:', err);
    return NextResponse.json({ error: '获取配置失败' }, { status: 500 });
  }
}

/**
 * PUT /api/admin/soniox
 * 更新 Soniox 配置（API Key 加密存储）
 */
export async function PUT(req: Request) {
  const { response } = await requireAdminAccess(req, {
    scope: 'admin:soniox:update',
    limit: 20,
    windowMs: 10 * 60_000,
  });
  if (response) return response;

  try {
    const body = await req.json();
    const { regions, defaultRegion } = body as {
      regions?: Record<string, {
        apiKey?: string;
        wsUrl?: string;
        restUrl?: string;
      }>;
      defaultRegion?: string;
    };

    if (!regions || typeof regions !== 'object') {
      return NextResponse.json({ error: '请提供区域配置' }, { status: 400 });
    }

    // U66：先对全部区域的 URL 做预校验（任一非法立即 400，此时尚未写入任何数据），
    // 再把所有 upsert/delete + soniox_configured 更新放进单事务原子提交，只有提交成功后
    // 才失效缓存。否则「先写 apiKey → URL 非法早退」会留下已存的密钥，却跳过配置标记
    // 和缓存失效，导致 GET 仍报 configured:false、实时转录继续用陈旧密钥最长 60s。
    type Op =
      | { kind: 'upsert'; key: string; value: string }
      | { kind: 'delete'; key: string };
    const ops: Op[] = [];

    for (const [region, config] of Object.entries(regions)) {
      if (!VALID_REGIONS.includes(region as typeof VALID_REGIONS[number])) continue;
      if (!config) continue;

      const upper = region.toUpperCase();

      // API Key：非空则加密写入，空字符串 = 删除
      if (config.apiKey !== undefined) {
        if (config.apiKey) {
          ops.push({ kind: 'upsert', key: `soniox_${upper}_api_key`, value: encrypt(config.apiKey) });
        } else {
          ops.push({ kind: 'delete', key: `soniox_${upper}_api_key` });
        }
      }

      // 自定义 URL（写入前做格式校验 + 私网过滤，防 SSRF）
      if (config.wsUrl !== undefined) {
        if (config.wsUrl) {
          let safeWsUrl: string;
          try {
            safeWsUrl = validateSonioxWsUrl(config.wsUrl);
          } catch {
            return NextResponse.json(
              { error: `${region} 区域的 wsUrl 必须是合法的 ws(s) 地址，且不能指向内网/本地地址` },
              { status: 400 }
            );
          }
          ops.push({ kind: 'upsert', key: `soniox_${upper}_ws_url`, value: safeWsUrl });
        } else {
          ops.push({ kind: 'delete', key: `soniox_${upper}_ws_url` });
        }
      }

      if (config.restUrl !== undefined) {
        if (config.restUrl) {
          let safeRestUrl: string;
          try {
            safeRestUrl = validateSonioxRestUrl(config.restUrl);
          } catch {
            return NextResponse.json(
              { error: `${region} 区域的 restUrl 必须是合法的 http(s) 地址，且不能指向内网/本地地址` },
              { status: 400 }
            );
          }
          ops.push({ kind: 'upsert', key: `soniox_${upper}_rest_url`, value: safeRestUrl });
        } else {
          ops.push({ kind: 'delete', key: `soniox_${upper}_rest_url` });
        }
      }
    }

    // 默认区域
    if (defaultRegion && VALID_REGIONS.includes(defaultRegion as typeof VALID_REGIONS[number])) {
      ops.push({ kind: 'upsert', key: 'soniox_default_region', value: defaultRegion });
    }

    // 计算提交后是否仍存在任何 API Key（含本次未触及的区域），据此定 soniox_configured。
    const apiKeyKeys = VALID_REGIONS.map((r) => `soniox_${r.toUpperCase()}_api_key`);
    const existingApiKeyRows = await prisma.siteSetting.findMany({
      where: { key: { in: apiKeyKeys } },
      select: { key: true },
    });
    const remainingKeys = new Set(existingApiKeyRows.map((row) => row.key));
    for (const op of ops) {
      if (!apiKeyKeys.includes(op.key)) continue;
      if (op.kind === 'upsert') remainingKeys.add(op.key);
      else remainingKeys.delete(op.key);
    }
    const configuredValue = remainingKeys.size > 0 ? 'true' : 'false';

    // 原子提交：全部区域写入 + 配置标记同进一个事务
    await prisma.$transaction([
      ...ops.map((op) =>
        op.kind === 'upsert'
          ? prisma.siteSetting.upsert({
              where: { key: op.key },
              update: { value: op.value },
              create: { key: op.key, value: op.value },
            })
          : prisma.siteSetting.deleteMany({ where: { key: op.key } })
      ),
      prisma.siteSetting.upsert({
        where: { key: 'soniox_configured' },
        update: { value: configuredValue },
        create: { key: 'soniox_configured', value: configuredValue },
      }),
    ]);

    // 只有提交成功后才失效缓存
    invalidateSiteSettingsCache();
    invalidateSonioxDbConfigCache();

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('更新 Soniox 配置失败:', err);
    return NextResponse.json({ error: '更新配置失败' }, { status: 500 });
  }
}
