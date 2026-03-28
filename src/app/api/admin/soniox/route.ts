// src/app/api/admin/soniox/route.ts
// 管理 Soniox API Key 配置（加密存储）

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { encrypt, decrypt } from '@/lib/crypto';
import { invalidateSiteSettingsCache } from '@/lib/siteSettings';
import { invalidateSonioxDbConfigCache } from '@/lib/soniox/env';

const VALID_REGIONS = ['us', 'eu', 'jp'] as const;

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

    // 逐区域更新
    for (const [region, config] of Object.entries(regions)) {
      if (!VALID_REGIONS.includes(region as typeof VALID_REGIONS[number])) continue;
      if (!config) continue;

      const upper = region.toUpperCase();

      // 更新 API Key（仅当提供了非空值时才更新，空字符串表示删除）
      if (config.apiKey !== undefined) {
        if (config.apiKey) {
          await prisma.siteSetting.upsert({
            where: { key: `soniox_${upper}_api_key` },
            update: { value: encrypt(config.apiKey) },
            create: { key: `soniox_${upper}_api_key`, value: encrypt(config.apiKey) },
          });
        } else {
          // 空字符串 = 删除
          await prisma.siteSetting.deleteMany({
            where: { key: `soniox_${upper}_api_key` },
          });
        }
      }

      // 更新自定义 URL
      if (config.wsUrl !== undefined) {
        if (config.wsUrl) {
          await prisma.siteSetting.upsert({
            where: { key: `soniox_${upper}_ws_url` },
            update: { value: config.wsUrl },
            create: { key: `soniox_${upper}_ws_url`, value: config.wsUrl },
          });
        } else {
          await prisma.siteSetting.deleteMany({
            where: { key: `soniox_${upper}_ws_url` },
          });
        }
      }

      if (config.restUrl !== undefined) {
        if (config.restUrl) {
          await prisma.siteSetting.upsert({
            where: { key: `soniox_${upper}_rest_url` },
            update: { value: config.restUrl },
            create: { key: `soniox_${upper}_rest_url`, value: config.restUrl },
          });
        } else {
          await prisma.siteSetting.deleteMany({
            where: { key: `soniox_${upper}_rest_url` },
          });
        }
      }
    }

    // 更新默认区域
    if (defaultRegion && VALID_REGIONS.includes(defaultRegion as typeof VALID_REGIONS[number])) {
      await prisma.siteSetting.upsert({
        where: { key: 'soniox_default_region' },
        update: { value: defaultRegion },
        create: { key: 'soniox_default_region', value: defaultRegion },
      });
    }

    // 检查是否有任何区域配置了 API Key
    const hasAnyKey = await prisma.siteSetting.findFirst({
      where: {
        key: { in: VALID_REGIONS.map(r => `soniox_${r.toUpperCase()}_api_key`) },
      },
    });

    // 更新配置标记
    await prisma.siteSetting.upsert({
      where: { key: 'soniox_configured' },
      update: { value: hasAnyKey ? 'true' : 'false' },
      create: { key: 'soniox_configured', value: hasAnyKey ? 'true' : 'false' },
    });

    invalidateSiteSettingsCache();
    invalidateSonioxDbConfigCache();

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('更新 Soniox 配置失败:', err);
    return NextResponse.json({ error: '更新配置失败' }, { status: 500 });
  }
}
