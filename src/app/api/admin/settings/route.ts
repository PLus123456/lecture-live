import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { logAction } from '@/lib/auditLog';
import {
  getSiteSettings,
  invalidateSiteSettingsCache,
  serializeSiteSettingsForAdmin,
  MAX_BACKUP_URLS,
} from '@/lib/siteSettings';
import { invalidateSonioxDbConfigCache } from '@/lib/soniox/env';
import { invalidateTrustedProxyCache } from '@/lib/clientIp';
import { migrateLocalToCloudreve } from '@/lib/storage/migration';
import { invalidateCloudreveConfigCache } from '@/lib/storage/cloudreve';

// 获取所有站点设置
export async function GET(req: Request) {
  const { response } = await requireAdminAccess(req, {
    scope: 'admin:settings:get',
    limit: 60,
  });
  if (response) {
    return response;
  }

  try {
    const settings = await getSiteSettings({ fresh: true });
    return NextResponse.json(serializeSiteSettingsForAdmin(settings));
  } catch (err) {
    console.error('获取站点设置失败:', err);
    return NextResponse.json({ error: '获取设置失败' }, { status: 500 });
  }
}

// 批量更新站点设置
export async function PUT(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:settings:update',
    limit: 20,
    windowMs: 10 * 60_000,
  });
  if (response) {
    return response;
  }

  try {
    const body = await req.json();

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
    }

    // 允许的设置键白名单
    const allowedKeys = new Set([
      // 站点信息
      'site_name',
      'site_description',
      'site_url',
      'site_url_backups',
      'footer_code',
      'site_announcement',
      'terms_url',
      'privacy_url',
      'logo_path',
      'favicon_path',
      'icon_medium_path',
      'icon_large_path',
      // 注册相关
      'allow_registration',
      'default_group',
      'default_user_role',
      'email_verification',
      'password_min_length',
      // 邮件相关
      'smtp_host',
      'smtp_port',
      'smtp_user',
      'smtp_password',
      'sender_name',
      'sender_email',
      // 存储相关
      'storage_mode',
      'cloudreve_url',
      'cloudreve_client_id',
      'cloudreve_client_secret',
      'local_path',
      'max_file_size',
      'local_retention_days',
      // 外观相关
      'theme',
      'language',
      'default_language',
      // ASR 相关
      'default_region',
      'default_source_lang',
      'default_target_lang',
      'translation_mode',
      // 安全相关
      'rate_limit_auth',
      'rate_limit_api',
      'jwt_expiry',
      'bcrypt_rounds',
      'trusted_proxy',
    ]);

    // 过滤非法键
    const entries = Object.entries(body).filter(([key]) => allowedKeys.has(key));

    if (entries.length === 0) {
      return NextResponse.json({ error: '没有有效的设置项' }, { status: 400 });
    }

    // 预处理 site_url_backups：必须是数组，清洗 + 合法性校验
    const backupsIdx = entries.findIndex(([key]) => key === 'site_url_backups');
    if (backupsIdx >= 0) {
      const rawBackups = entries[backupsIdx][1];
      if (!Array.isArray(rawBackups)) {
        return NextResponse.json(
          { error: '备用 URL 必须是数组' },
          { status: 400 }
        );
      }

      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const item of rawBackups) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (!trimmed) continue;
        try {
          new URL(trimmed);
        } catch {
          return NextResponse.json(
            { error: `备用 URL 格式不正确: ${trimmed}` },
            { status: 400 }
          );
        }
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        cleaned.push(trimmed);
      }

      if (cleaned.length > MAX_BACKUP_URLS) {
        return NextResponse.json(
          { error: `备用 URL 最多 ${MAX_BACKUP_URLS} 个` },
          { status: 400 }
        );
      }

      // 替换 entries 中的原值，后续 flatMap 统一处理
      entries[backupsIdx] = ['site_url_backups', JSON.stringify(cleaned)];
    }

    // 记录切换前的存储模式，用于检测是否需要迁移
    const previousSettings = await getSiteSettings({ fresh: true });

    logAction(req, 'admin.settings.update', {
      user: admin,
      detail: `更新设置项: ${entries.map(([k]) => k).join(', ')}`,
    });

    const normalizedEntries = entries.flatMap(([key, value]) => {
      const normalizedValue =
        typeof value === 'boolean' ? String(value) : String(value ?? '');
      const mirroredEntries: Array<[string, string]> = [[key, normalizedValue]];

      if (key === 'default_region') {
        mirroredEntries.push(['soniox_default_region', normalizedValue]);
      }

      if (key === 'language') {
        mirroredEntries.push(['default_language', normalizedValue]);
      }

      // 保存新 backups 时同步清空老字段 site_url_alt
      if (key === 'site_url_backups') {
        mirroredEntries.push(['site_url_alt', '']);
      }

      return mirroredEntries;
    });

    // 使用事务逐个 upsert
    await prisma.$transaction(
      normalizedEntries.map(([key, value]) =>
        prisma.siteSetting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        })
      )
    );

    invalidateSiteSettingsCache();
    invalidateSonioxDbConfigCache();
    invalidateTrustedProxyCache();
    invalidateCloudreveConfigCache();
    const settings = await getSiteSettings({ fresh: true });

    // 如果存储模式从 local 切换到 cloudreve，后台触发迁移
    const switchedToCloudreve =
      previousSettings.storage_mode !== 'cloudreve' &&
      settings.storage_mode === 'cloudreve';

    if (switchedToCloudreve) {
      // 后台执行，不阻塞响应
      migrateLocalToCloudreve()
        .then((r) =>
          console.log(
            `[存储迁移] 完成: 迁移 ${r.migratedCount} 个文件, 跳过 ${r.skippedCount}, 错误 ${r.errorCount}`
          )
        )
        .catch((err) => console.error('[存储迁移] 失败:', err));
    }

    return NextResponse.json({
      ...serializeSiteSettingsForAdmin(settings),
      _migrationTriggered: switchedToCloudreve,
    });
  } catch (err) {
    console.error('更新站点设置失败:', err);
    return NextResponse.json({ error: '更新设置失败' }, { status: 500 });
  }
}
