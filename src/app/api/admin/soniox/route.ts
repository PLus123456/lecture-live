// src/app/api/admin/soniox/route.ts
// 管理 Soniox API Key 配置（加密存储）

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { encrypt, decrypt } from '@/lib/crypto';
import { invalidateSiteSettingsCache } from '@/lib/siteSettings';
import { invalidateSonioxDbConfigCache } from '@/lib/soniox/env';
// P6-4：校验实现搬到 @/lib/sonioxUrlValidation，与公开的 /api/setup 路径共用一份，
// 免得同一防护再次只装在一条路径上。
import {
  validateSonioxRestUrl,
  validateSonioxWsUrl,
} from '@/lib/sonioxUrlValidation';
import { writeSecurityAudit } from '@/lib/securityAudit';

const VALID_REGIONS = ['us', 'eu', 'jp'] as const;


/**
 * GET /api/admin/soniox
 * 获取 Soniox 配置状态（不返回完整 API Key，仅返回是否已配置）
 */
export async function GET(req: Request) {
  const { user, response } = await requireAdminAccess(req, {
    scope: 'admin:soniox:get',
    limit: 60,
  });
  if (response || !user) return response!;

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

    const responseBody = {
      configured: settings.soniox_configured === 'true',
      defaultRegion: settings.soniox_default_region || 'us',
      regions,
    };

    await writeSecurityAudit(req, {
      event: 'soniox.read',
      operator: user,
      target: { type: 'soniox_configuration', id: 'global' },
      before: null,
      after: null,
      reason: 'admin-soniox-configuration-read',
      outcome: 'SUCCESS',
      metadata: {
        configured: responseBody.configured,
        defaultRegion: responseBody.defaultRegion,
        configuredRegions: VALID_REGIONS.filter((region) => regions[region].hasApiKey),
      },
    });

    return NextResponse.json(responseBody);
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
  const { user, response } = await requireAdminAccess(req, {
    scope: 'admin:soniox:update',
    limit: 20,
    windowMs: 10 * 60_000,
  });
  if (response || !user) return response!;

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

    // 已存值（密钥 + 两个自定义地址），供「改端点必须重填密钥」判定与下面的 configured 计算共用。
    const apiKeyKeys = VALID_REGIONS.map((r) => `soniox_${r.toUpperCase()}_api_key`);
    const regionSettingKeys = VALID_REGIONS.flatMap((r) => {
      const u = r.toUpperCase();
      return [
        `soniox_${u}_api_key`,
        `soniox_${u}_ws_url`,
        `soniox_${u}_rest_url`,
      ];
    });

    for (const [region, config] of Object.entries(regions)) {
      if (!VALID_REGIONS.includes(region as typeof VALID_REGIONS[number])) continue;
      if (!config) continue;

      const upper = region.toUpperCase();

      // 注：这里**刻意不做**「改 wsUrl/restUrl 必须重填 apiKey」的换靶闸
      //（P2-2 已收窄为只保 SMTP）。自建代理/中转地址会变，不该每次都逼着重填密钥。
      // 下面的 validateSonioxWsUrl / validateSonioxRestUrl 仍在挡内网地址。
      // 残余风险与收口方向见 admin/settings/route.ts 里的说明。

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

    // 原子提交：当前值、全部区域写入、配置标记与 SUCCESS 审计共用一个事务。
    await prisma.$transaction(async (tx) => {
      const existingRows = await tx.siteSetting.findMany({
        where: {
          key: {
            in: [...regionSettingKeys, 'soniox_default_region', 'soniox_configured'],
          },
        },
        select: { key: true, value: true },
      });
      const existingByKey = new Map(existingRows.map((row) => [row.key, row.value]));
      const remainingKeys = new Set(apiKeyKeys.filter((key) => existingByKey.has(key)));
      for (const op of ops) {
        if (!apiKeyKeys.includes(op.key)) continue;
        if (op.kind === 'upsert') remainingKeys.add(op.key);
        else remainingKeys.delete(op.key);
      }
      const configuredValue = remainingKeys.size > 0 ? 'true' : 'false';

      for (const op of ops) {
        if (op.kind === 'upsert') {
          await tx.siteSetting.upsert({
            where: { key: op.key },
            update: { value: op.value },
            create: { key: op.key, value: op.value },
          });
        } else {
          await tx.siteSetting.deleteMany({ where: { key: op.key } });
        }
      }
      await tx.siteSetting.upsert({
        where: { key: 'soniox_configured' },
        update: { value: configuredValue },
        create: { key: 'soniox_configured', value: configuredValue },
      });

      const touchedRegions = VALID_REGIONS.filter((region) =>
        ops.some((op) => op.key.startsWith(`soniox_${region.toUpperCase()}_`))
      );
      const apiKeyChanges = Object.fromEntries(
        touchedRegions.map((region) => [
          region,
          ops.some((op) => op.key === `soniox_${region.toUpperCase()}_api_key`),
        ])
      );
      await writeSecurityAudit(
        req,
        {
          event: 'soniox.update',
          operator: user,
          target: { type: 'soniox_configuration', id: 'global' },
          before: {
            configured: existingByKey.get('soniox_configured') === 'true',
            defaultRegion: existingByKey.get('soniox_default_region') ?? 'us',
          },
          after: {
            configured: configuredValue === 'true',
            defaultRegion:
              defaultRegion && VALID_REGIONS.includes(defaultRegion as typeof VALID_REGIONS[number])
                ? defaultRegion
                : existingByKey.get('soniox_default_region') ?? 'us',
            touchedRegions,
            apiKeyChanges,
            endpointChanged: ops.some(
              (op) => op.key.endsWith('_ws_url') || op.key.endsWith('_rest_url')
            ),
          },
          reason: 'admin-soniox-configuration-update',
          outcome: 'SUCCESS',
        },
        tx
      );
    });

    // 只有提交成功后才失效缓存
    invalidateSiteSettingsCache();
    invalidateSonioxDbConfigCache();

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('更新 Soniox 配置失败:', err);
    return NextResponse.json({ error: '更新配置失败' }, { status: 500 });
  }
}
