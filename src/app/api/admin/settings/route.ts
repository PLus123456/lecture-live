import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { logger, serializeError } from '@/lib/logger';
import {
  getSecurityAuditRequestId,
  writeSecurityAudit,
} from '@/lib/securityAudit';
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
import { migrateLocalToCloudreve } from '@/lib/storage/migration';
import {
  clearPersistedTokens as clearCloudreveTokens,
  invalidateCloudreveConfigCache,
  validateCloudreveBaseUrl,
} from '@/lib/storage/cloudreve';
import { parseWorkerUrls } from '@/lib/audio/enhanceWorkerClient';
import { isValidEmailAddress, parseDomainListDetailed } from '@/lib/email/domains';
import { invalidateMailer } from '@/lib/email/mailer';
import {
  requiresSecretReentry,
  retargetErrorMessage,
} from '@/lib/credentialRetarget';
import { JOB_TYPE, trackJob } from '@/lib/jobQueue';

// 获取所有站点设置
export async function GET(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:settings:get',
    limit: 60,
  });
  if (response) {
    return response;
  }
  if (!admin) {
    return NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  try {
    const settings = await getSiteSettings({ fresh: true });
    const payload = serializeSiteSettingsForAdmin(settings);

    try {
      await writeSecurityAudit(req, {
        event: 'settings.read',
        operator: {
          id: admin.id,
          email: admin.email,
          role: admin.role,
        },
        target: { type: 'site_settings', id: 'global' },
        before: null,
        after: {
          keys: Object.keys(payload).sort(),
          secretValuesMasked: true,
        },
        reason: 'admin_read',
        outcome: 'SUCCESS',
      });
    } catch (auditError) {
      logger.error(
        { err: serializeError(auditError) },
        '记录站点设置读取审计失败'
      );
      return NextResponse.json(
        { error: '安全审计服务不可用' },
        { status: 503 }
      );
    }

    return NextResponse.json(payload);
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
  if (!admin) {
    return NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  const auditRequestId = getSecurityAuditRequestId(req);
  let auditAttempted = false;
  let primarySettingsCommitted = false;
  let auditContext:
    | {
        target: {
          type: string;
          id: string;
          ids: string[];
        };
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      }
    | undefined;

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
      // trusted_proxy 是旧版数据库 boolean，只保留读取兼容。真实代理拓扑必须由
      // TRUSTED_PROXY_HOPS/CIDRS 在 Web/WS 启动前确定，禁止通过热更新接口切换。
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
      // 翻译模块（worker 列表在 TranslationWorker 表，走 /api/admin/translate/workers）
      'translation_text_enabled',
      'translation_text_daily_free_limit',
      'translation_text_billing_mode',
      'translation_text_price_cents_per_kchar',
      'translation_doc_enabled',
      'translation_doc_price_cents_per_page',
      'translation_doc_max_pages',
      'translation_doc_max_mb',
      'translation_doc_watermark',
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

    // ── 改端点必须重填凭据（P2-1 / P2-2）──
    // 上面「空/掩码 = 保留原密文」的语义，配上「端点键随便改」，本身就是一条外带通道：
    // 一次 PUT {smtp_host: 攻击者, smtp_password: '********'} 就换了靶且留住原口令，
    // 紧接着的 invalidateMailer() 让下一封信立刻对新 host 跑 AUTH LOGIN —— 明文口令随之送出。
    // mailer.resolveConfigWithOverride 里本来就有这条规则，但它只覆盖后台「测试连接」；
    // 生产发信 sendMail() 直接读落库配置、零校验，所以闸必须落在**写入侧**。
    // Cloudreve / 音频增强 worker 是同一形状（改地址 → 凭据随下一次调用送到新地址），一并挡。
    const submitted = new Map<string, unknown>(filteredEntries);
    // worker 地址是「逗号/换行分隔多台」，两侧都按 parseWorkerUrls 归一，避免仅空格差异被误判改靶
    const normalizeFleet = (raw: unknown) =>
      parseWorkerUrls(typeof raw === 'string' ? raw : '').join(',');
    if (submitted.has('audio_enhance_worker_url')) {
      submitted.set(
        'audio_enhance_worker_url',
        normalizeFleet(submitted.get('audio_enhance_worker_url'))
      );
    }
    const prevEndpoints: Record<string, unknown> = {
      ...previousSettings,
      audio_enhance_worker_url: normalizeFleet(
        previousSettings.audio_enhance_worker_url
      ),
    };
    // 本 settings 路由里，「改端点必须重填凭据」目前覆盖 SMTP。LLM provider
    // 不在 SiteSetting 表中，已在 /api/admin/llm-providers/[id] 的写入边界单独强制。
    //
    // 保留 SMTP 的理由：邮件服务商地址几乎不会变（改它基本只有换靶一种解释），而 SMTP 口令
    // 常常就是邮箱账号本身的密码、在别处复用，外带出去的破坏面最大。管理员真要改也一定知道
    // 这个口令，重填成本≈0。
    //
    // 其余几类（Cloudreve / 音频增强 worker / 翻译 worker / Soniox）仍未在本路由强制：
    // 那些地址通常是自建服务，机器 IP 一变就得改，却要求重填一把可能根本取不回来的密钥
    // 代价明显大于收益。
    //
    // 放开后接受的残余风险（明确记录，不要当成没有）：admin 会话一旦失陷（XSS / cookie 泄露 /
    // 内部人），攻击者可以「改地址 + 密钥留空」让服务端把解密后的真实凭据主动投递到新地址
    //（worker token 等都是一次握手就送出去）。这条通道无法从
    // GET 侧堵住——GET 一直是脱敏的，它绕的正是脱敏。真要收口，方向是给这类改动加一次
    // 登录密码二次确认（盗号者不知道登录密码），而不是把重填密钥的负担压回管理员身上。
    const retargetGuards: Array<{
      secretKey: string;
      endpointKeys: string[];
      endpointLabel: string;
      secretLabel: string;
    }> = [
      {
        secretKey: 'smtp_password',
        endpointKeys: ['smtp_host', 'smtp_port', 'smtp_user'],
        endpointLabel: 'SMTP 主机 / 端口 / 账号',
        secretLabel: 'SMTP 密码',
      },
    ];
    for (const guard of retargetGuards) {
      if (
        requiresSecretReentry({
          endpoint: guard.endpointKeys.map((key) => ({
            current: prevEndpoints[key],
            next: submitted.get(key),
          })),
          hasStoredSecret: Boolean(prevEndpoints[guard.secretKey]),
          suppliedSecret: submitted.get(guard.secretKey),
        })
      ) {
        return NextResponse.json(
          {
            error: retargetErrorMessage(guard.endpointLabel, guard.secretLabel),
          },
          { status: 400 }
        );
      }
    }

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

    const normalizedEntryMap = new Map(normalizedEntries);
    const cloudreveCredentialsChanged =
      (normalizedEntryMap.has('cloudreve_url') &&
        normalizedEntryMap.get('cloudreve_url') !==
          String(previousSettings.cloudreve_url ?? '')) ||
      (normalizedEntryMap.has('cloudreve_client_id') &&
        normalizedEntryMap.get('cloudreve_client_id') !==
          String(previousSettings.cloudreve_client_id ?? '')) ||
      normalizedEntryMap.has('cloudreve_client_secret');
    const switchedToCloudreve =
      previousSettings.storage_mode !== 'cloudreve' &&
      (normalizedEntryMap.get('storage_mode') ?? previousSettings.storage_mode) ===
        'cloudreve';

    const auditSensitiveKeys = new Set(sensitiveKeys);
    const auditValue = (key: string, value: unknown, changed: boolean) =>
      auditSensitiveKeys.has(key)
        ? { configured: Boolean(value), changed }
        : value;
    const previousSettingsRecord = previousSettings as unknown as Record<
      string,
      unknown
    >;
    const auditKeys = [...new Set(normalizedEntries.map(([key]) => key))].sort();
    const settingsAuditContext = {
      target: {
        type: 'site_settings',
        id: 'global',
        ids: auditKeys,
      },
      before: Object.fromEntries(
        auditKeys.map((key) => [
          key,
          auditValue(key, previousSettingsRecord[key], false),
        ])
      ),
      after: Object.fromEntries(
        normalizedEntries.map(([key, value]) => [
          key,
          auditValue(key, value, true),
        ])
      ),
    };
    auditContext = settingsAuditContext;

    try {
      await writeSecurityAudit(req, {
        event: 'settings.update',
        operator: {
          id: admin.id,
          email: admin.email,
          role: admin.role,
        },
        ...settingsAuditContext,
        reason: 'admin_update',
        outcome: 'ATTEMPTED',
        requestId: auditRequestId,
      });
      auditAttempted = true;
    } catch (auditError) {
      logger.error(
        { err: serializeError(auditError) },
        '记录站点设置更新尝试失败'
      );
      return NextResponse.json(
        { error: '安全审计服务不可用' },
        { status: 503 }
      );
    }

    // 设置、由设置派生的用户配额、旧 OAuth token 清理以及 SUCCESS 审计是一个
    // 数据库事实：任何一步失败都必须整体回滚，不能留下“配置已改但审计/配额未改”的状态。
    const STORAGE_QUOTA_MB = 1024 * 1024;
    const parseQuotaMb = (raw: string | undefined, fallback: number) => {
      const parsed = Number.parseInt(raw ?? '', 10);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(1_048_576, Math.max(0, parsed));
    };
    const byteQuotaChanges: Array<{
      role: 'FREE' | 'PRO' | 'ADMIN';
      key:
        | 'chat_files_quota_free_mb'
        | 'chat_files_quota_pro_mb'
        | 'chat_files_quota_admin_mb';
      previous: number;
    }> = [
      {
        role: 'FREE',
        key: 'chat_files_quota_free_mb',
        previous: previousSettings.chat_files_quota_free_mb,
      },
      {
        role: 'PRO',
        key: 'chat_files_quota_pro_mb',
        previous: previousSettings.chat_files_quota_pro_mb,
      },
      {
        role: 'ADMIN',
        key: 'chat_files_quota_admin_mb',
        previous: previousSettings.chat_files_quota_admin_mb,
      },
    ];

    await prisma.$transaction(async (tx) => {
      for (const [key, value] of normalizedEntries) {
        await tx.siteSetting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        });
      }

      for (const change of byteQuotaChanges) {
        if (!normalizedEntryMap.has(change.key)) continue;
        const nextMb = parseQuotaMb(
          normalizedEntryMap.get(change.key),
          change.previous
        );
        if (nextMb === change.previous) continue;
        await tx.user.updateMany({
          where: { role: change.role },
          data: {
            storageBytesLimit:
              BigInt(Math.floor(nextMb)) * BigInt(STORAGE_QUOTA_MB),
          },
        });
      }

      if (cloudreveCredentialsChanged) {
        await clearCloudreveTokens(tx);
      }

      await writeSecurityAudit(
        req,
        {
          event: 'settings.update',
          operator: {
            id: admin.id,
            email: admin.email,
            role: admin.role,
          },
          ...settingsAuditContext,
          reason: 'admin_update',
          outcome: 'SUCCESS',
          metadata: {
            cloudreveCredentialsChanged,
            migrationRequired: switchedToCloudreve,
          },
          requestId: auditRequestId,
        },
        tx
      );
    });
    primarySettingsCommitted = true;

    invalidateSiteSettingsCache();
    invalidateSonioxDbConfigCache();
    invalidateCloudreveConfigCache();
    invalidateMailer(); // SMTP 配置可能已变，丢弃缓存的 transporter
    const settings = await getSiteSettings({ fresh: true });

    // 切换存储后，迁移是外部副作用：必须先持久化 PROCESSING journal，且终态与
    // 结构化审计同事务落库。请求等待终态，禁止 fire-and-forget 丢失结果。
    if (switchedToCloudreve) {
      await trackJob(
        {
          type: JOB_TYPE.STORAGE_MIGRATION,
          triggeredBy: `admin:${admin.id}`,
          params: { direction: 'local_to_cloudreve', source: 'settings' },
          resultSummary: (result) => ({
            migratedCount: result.migratedCount,
            skippedCount: result.skippedCount,
            errorCount: result.errorCount,
          }),
          errorSummary: (error) =>
            error instanceof Error ? error.name : 'UnknownError',
          terminalMutation: async (tx, terminal) => {
            const result =
              terminal.status === 'SUCCESS' ? terminal.result : undefined;
            await writeSecurityAudit(
              req,
              {
                event: 'settings.storage_migration',
                operator: {
                  id: admin.id,
                  email: admin.email,
                  role: admin.role,
                },
                target: { type: 'storage_backend', id: 'global' },
                before: { backend: 'local' },
                after: result
                  ? {
                      backend: 'cloudreve',
                      migratedCount: result.migratedCount,
                      skippedCount: result.skippedCount,
                      errorCount: result.errorCount,
                    }
                  : undefined,
                reason: 'settings_storage_switch',
                outcome: !result
                  ? 'FAILED'
                  : result.errorCount > 0
                    ? 'PARTIAL'
                    : 'SUCCESS',
                metadata: result
                  ? undefined
                  : {
                      errorClass:
                        terminal.status === 'FAILED' &&
                        terminal.error instanceof Error
                          ? terminal.error.name
                          : 'UnknownError',
                    },
                requestId: auditRequestId,
              },
              tx
            );
          },
        },
        () => migrateLocalToCloudreve()
      );
    }

    return NextResponse.json({
      ...serializeSiteSettingsForAdmin(settings),
      _migrationTriggered: switchedToCloudreve,
    });
  } catch (err) {
    logger.error({ err: serializeError(err) }, '更新站点设置失败');

    if (auditAttempted && auditContext) {
      try {
        await writeSecurityAudit(req, {
          event: 'settings.update',
          operator: {
            id: admin.id,
            email: admin.email,
            role: admin.role,
          },
          ...auditContext,
          reason: 'admin_update',
          outcome: primarySettingsCommitted ? 'PARTIAL' : 'FAILED',
          metadata: {
            errorType: err instanceof Error ? err.name : 'UnknownError',
          },
          requestId: auditRequestId,
        });
      } catch (auditError) {
        logger.error(
          { err: serializeError(auditError) },
          '记录站点设置更新失败结果失败'
        );
        return NextResponse.json(
          { error: '安全审计服务不可用' },
          { status: 503 }
        );
      }
    }

    return NextResponse.json({ error: '更新设置失败' }, { status: 500 });
  }
}
