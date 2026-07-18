import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { logAction } from '@/lib/auditLog';
import { logger, serializeError } from '@/lib/logger';
import {
  getSiteSettings,
  invalidateSiteSettingsCache,
  serializeSiteSettingsForAdmin,
  MAX_BACKUP_URLS,
  SENSITIVE_SETTING_KEYS,
  SETTING_SECRET_MASK,
} from '@/lib/siteSettings';
import { encrypt } from '@/lib/crypto';
import { invalidateSonioxDbConfigCache } from '@/lib/soniox/env';
import { invalidateTrustedProxyCache } from '@/lib/clientIp';
import { migrateLocalToCloudreve } from '@/lib/storage/migration';
import {
  clearPersistedTokens as clearCloudreveTokens,
  invalidateCloudreveConfigCache,
  validateCloudreveBaseUrl,
} from '@/lib/storage/cloudreve';
import { parseWorkerUrls } from '@/lib/audio/enhanceWorkerClient';
import { isValidEmailAddress, parseDomainListDetailed } from '@/lib/email/domains';
import { invalidateMailer } from '@/lib/email/mailer';

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
    logger.error({ err: serializeError(err) }, '获取站点设置失败');
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
      // 注：新用户默认角色由 default_group 驱动（getSiteSettings 读取并在 auth 流程生效）。
      // 历史上还写过 default_user_role，但从未有读取方 —— 是写得进、读不出的幽灵键，已移除避免误导。
      'email_verification',
      'password_min_length',
      // 注册域名管控（教育邮箱白名单 + 一次性邮箱拦截）
      'block_disposable_email',
      'disposable_email_extra',
      'email_domain_allowlist',
      'email_domain_allowlist_enforce',
      // 邮件相关
      'smtp_host',
      'smtp_port',
      'smtp_user',
      'smtp_password',
      'smtp_secure',
      'sender_name',
      'sender_email',
      'marketing_emails_enabled',
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
      // Chat 文件配额 & 清理（U13）
      'chat_files_retention_days',
      'chat_files_soft_cap_percent',
      'chat_files_max_upload_mb',
      'chat_files_quota_free_mb',
      'chat_files_quota_pro_mb',
      'chat_files_quota_admin_mb',
      // 异步上传转录计费倍率（批2）
      'async_upload_billing_multiplier',
      // 录音音频增强（外部 worker 后处理）
      'audio_enhance_enabled',
      'audio_enhance_worker_url',
      'audio_enhance_worker_token',
      'audio_enhance_target_lufs',
      'audio_enhance_atten_lim_db',
      'audio_enhance_concurrency',
    ]);

    // 过滤非法键
    const filteredEntries = Object.entries(body).filter(([key]) =>
      allowedKeys.has(key)
    );

    if (filteredEntries.length === 0) {
      return NextResponse.json({ error: '没有有效的设置项' }, { status: 400 });
    }

    // 敏感凭据处理：空串或脱敏占位 '********' = 保持原值（不写，避免把脱敏值回存清空）；
    // 否则加密后落库（与 LLM/Soniox 凭据一致，静态加密 + GET 脱敏）。
    const sensitiveKeys = SENSITIVE_SETTING_KEYS as readonly string[];
    const entries = filteredEntries.flatMap<[string, unknown]>(
      ([key, value]) => {
        if (!sensitiveKeys.includes(key)) {
          return [[key, value]];
        }
        const str = typeof value === 'string' ? value.trim() : '';
        if (!str || str === SETTING_SECRET_MASK) {
          return []; // 保留原有密文，不写
        }
        return [[key, encrypt(str)]];
      }
    );

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

    // 音频增强 worker 地址：支持逗号/换行分隔多台，逐台做格式 + 私网过滤（防 SSRF，
    // 与 Soniox/Cloudreve 同口径）。空串 = 清除配置放行；合法值规范化（去尾斜杠去重）后落库。
    const workerUrlIdx = entries.findIndex(
      ([key]) => key === 'audio_enhance_worker_url'
    );
    if (workerUrlIdx >= 0) {
      const rawUrl = entries[workerUrlIdx][1];
      const workerUrls = parseWorkerUrls(
        typeof rawUrl === 'string' ? rawUrl : ''
      );
      for (const url of workerUrls) {
        try {
          validateCloudreveBaseUrl(url);
        } catch (error) {
          return NextResponse.json(
            {
              error: `音频增强 worker 地址不合法 (${url}): ${
                error instanceof Error ? error.message : 'invalid URL'
              }`,
            },
            { status: 400 }
          );
        }
      }
      entries[workerUrlIdx] = ['audio_enhance_worker_url', workerUrls.join(',')];
    }

    // 发件人邮箱格式校验（非空时）：配错的 From 地址会导致所有外发邮件被拒，提前拦下。
    const senderEmailIdx = entries.findIndex(([key]) => key === 'sender_email');
    if (senderEmailIdx >= 0) {
      const rawSender = entries[senderEmailIdx][1];
      const senderStr = typeof rawSender === 'string' ? rawSender.trim() : '';
      if (senderStr && !isValidEmailAddress(senderStr)) {
        return NextResponse.json(
          { error: `发件人邮箱格式不正确: ${senderStr}` },
          { status: 400 }
        );
      }
      entries[senderEmailIdx] = ['sender_email', senderStr];
    }

    // 注册域名白名单 / 一次性邮箱补充黑名单：逐条校验，**不接受静默丢弃**。
    // 此前 parseDomainList 会把 "*.edu.cn"、"edu"、".edu.cn" 这类写法直接吞掉，页面又原样回显
    // 管理员填的原文 —— 于是白名单解析成空数组、强制开关形同虚设，而他以为已经生效。
    // 落库统一存归一化后的结果，保证「设置页看到的」就是「实际生效的」。
    const domainListFields: Array<[key: string, label: string]> = [
      ['email_domain_allowlist', '注册域名白名单'],
      ['disposable_email_extra', '一次性邮箱补充黑名单'],
    ];
    for (const [key, label] of domainListFields) {
      const idx = entries.findIndex(([k]) => k === key);
      if (idx < 0) continue;
      const rawValue = entries[idx][1];
      const rawStr = typeof rawValue === 'string' ? rawValue : '';
      const parsed = parseDomainListDetailed(rawStr);
      if (parsed.invalid.length > 0) {
        return NextResponse.json(
          {
            error: `${label}存在无法识别的域名: ${parsed.invalid.join(', ')}。请填写域名本身（如 edu.cn、stanford.edu），不要使用通配符或前导点，子域名会自动匹配。`,
          },
          { status: 400 }
        );
      }
      entries[idx] = [key, parsed.valid.join(',')];
    }

    // 记录切换前的存储模式，用于检测是否需要迁移
    const previousSettings = await getSiteSettings({ fresh: true });

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
    invalidateMailer(); // SMTP 配置可能已变，丢弃缓存的 transporter
    const settings = await getSiteSettings({ fresh: true });

    // U86：审计日志移到事务提交之后。此前在事务前 fire-and-forget 记录，事务失败会留下
    // 幽灵「已更新」审计行，重试成功后又写第二行，事后追溯配置变更时间会错位。
    logAction(req, 'admin.settings.update', {
      user: admin,
      detail: `更新设置项: ${entries.map(([k]) => k).join(', ')}`,
    });

    // Chat 字节配额联动：admin 改了某角色的 chat_files_quota_*_mb 后，把对应角色所有用户的
    // storageBytesLimit 回填到新值。这是让该设置真正生效的唯一写入点 —— 此前这三个值只存进
    // SiteSetting、从不推给任何用户，导致所有人（含 PRO）被钉死在 schema 默认 100MB。
    // 字节配额按角色驱动、自定义组沿用其底层角色配额，故按 role 全量更新（不排除自定义组成员）。
    const STORAGE_QUOTA_MB = 1024 * 1024;
    const byteQuotaByRole: Array<{ role: 'FREE' | 'PRO' | 'ADMIN'; mb: number; prevMb: number }> = [
      { role: 'FREE', mb: settings.chat_files_quota_free_mb, prevMb: previousSettings.chat_files_quota_free_mb },
      { role: 'PRO', mb: settings.chat_files_quota_pro_mb, prevMb: previousSettings.chat_files_quota_pro_mb },
      { role: 'ADMIN', mb: settings.chat_files_quota_admin_mb, prevMb: previousSettings.chat_files_quota_admin_mb },
    ];
    for (const change of byteQuotaByRole) {
      if (change.mb !== change.prevMb && Number.isFinite(change.mb) && change.mb >= 0) {
        await prisma.user.updateMany({
          where: { role: change.role },
          data: {
            storageBytesLimit: BigInt(Math.floor(change.mb)) * BigInt(STORAGE_QUOTA_MB),
          },
        });
      }
    }

    // Cloudreve URL/Client 任一变更后，旧 token 不再匹配新 server/app —
    // 用旧 token 调新 client 必然 401，必须清空让管理员重新走 OAuth。
    const cloudreveCredentialsChanged =
      previousSettings.cloudreve_url !== settings.cloudreve_url ||
      previousSettings.cloudreve_client_id !== settings.cloudreve_client_id ||
      previousSettings.cloudreve_client_secret !== settings.cloudreve_client_secret;

    if (cloudreveCredentialsChanged) {
      await clearCloudreveTokens().catch((err) =>
        logger.error(
          { err: serializeError(err) },
          '[admin.settings] 清除 Cloudreve token 失败'
        )
      );
    }

    // 如果存储模式从 local 切换到 cloudreve，后台触发迁移
    const switchedToCloudreve =
      previousSettings.storage_mode !== 'cloudreve' &&
      settings.storage_mode === 'cloudreve';

    if (switchedToCloudreve) {
      // 后台执行，不阻塞响应
      migrateLocalToCloudreve()
        .then((r) =>
          logger.info(
            {
              migratedCount: r.migratedCount,
              skippedCount: r.skippedCount,
              errorCount: r.errorCount,
            },
            '[存储迁移] 完成'
          )
        )
        .catch((err) =>
          logger.error({ err: serializeError(err) }, '[存储迁移] 失败')
        );
    }

    return NextResponse.json({
      ...serializeSiteSettingsForAdmin(settings),
      _migrationTriggered: switchedToCloudreve,
    });
  } catch (err) {
    logger.error({ err: serializeError(err) }, '更新站点设置失败');
    return NextResponse.json({ error: '更新设置失败' }, { status: 500 });
  }
}
