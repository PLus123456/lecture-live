import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { withRequestLogging } from '@/lib/requestLogger';
import { getSecurityAuditRequestId, writeSecurityAudit } from '@/lib/securityAudit';
import { SETTING_SECRET_MASK } from '@/lib/siteSettings';
import {
  getRechargeSettings,
  updateRechargeSettings,
  serializeRechargeSettingsForAdmin,
  RechargeSettingsError,
  type RechargeSettings,
} from '@/lib/payment/settings';

const RECHARGE_SECRET_FIELDS = new Set<keyof RechargeSettings>([
  'alipayPrivateKey',
  'wechatApiV3Key',
  'wechatPrivateKey',
  'stripeSecretKey',
  'stripeWebhookSecret',
]);

const RECHARGE_AUDITABLE_FIELDS = new Set<keyof RechargeSettings>([
  'enabled',
  'currencySymbol',
  'currency',
  'alipayEnabled',
  'wechatEnabled',
  'stripeEnabled',
  'sandboxEnabled',
  'alipayAppId',
  'alipayPrivateKey',
  'alipayPublicKey',
  'alipaySellerId',
  'alipayGateway',
  'wechatAppId',
  'wechatMchId',
  'wechatApiV3Key',
  'wechatSerialNo',
  'wechatPrivateKey',
  'wechatPlatformCert',
  'stripeSecretKey',
  'stripeWebhookSecret',
  'stripePublishableKey',
]);

/** 审计提交差异时，凭据只记录是否实际变更，绝不复制明文或掩码。 */
function settingsPatchForAudit(patch: Partial<RechargeSettings>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(patch)) {
    const key = rawKey as keyof RechargeSettings;
    // 运行时 body 不是可信 TypeScript 对象；未知键既不会被配置层写入，也不得被复制进审计。
    if (!RECHARGE_AUDITABLE_FIELDS.has(key)) continue;
    if (RECHARGE_SECRET_FIELDS.has(key)) {
      safe[key] = { changed: value !== '' && value !== SETTING_SECRET_MASK };
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

function auditUnavailable(message: string, err: unknown): NextResponse {
  console.error(message, err);
  return NextResponse.json({ error: '安全审计服务暂时不可用' }, { status: 503 });
}

// 获取充值配置（敏感凭据脱敏）
export const GET = withRequestLogging('admin:recharge:settings:get', async (req: Request) => {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:recharge:settings:get',
  });
  if (response) return response;
  if (!admin) return NextResponse.json({ error: '权限不足' }, { status: 403 });
  const settings = await getRechargeSettings();
  const payload = { settings: serializeRechargeSettingsForAdmin(settings) };
  try {
    await writeSecurityAudit(req, {
      event: 'recharge.settings.read',
      operator: { id: admin.id, email: admin.email, role: admin.role },
      target: { type: 'recharge_settings', id: 'global' },
      reason: 'admin_list',
      outcome: 'SUCCESS',
      metadata: { count: 1 },
    });
  } catch (err) {
    return auditUnavailable('充值配置读取安全审计失败:', err);
  }
  return NextResponse.json(payload);
});

// 更新充值配置（部分更新；敏感字段收到掩码/空 = 保持原值）
export const PUT = withRequestLogging('admin:recharge:settings:update', async (req: Request) => {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:recharge:settings:update',
    limit: 30,
  });
  if (response) return response;

  let body: Partial<RechargeSettings>;
  try {
    body = (await req.json()) as Partial<RechargeSettings>;
  } catch {
    return NextResponse.json({ error: '请求体无效' }, { status: 400 });
  }

  if (!admin) return NextResponse.json({ error: '权限不足' }, { status: 403 });

  const requestId = getSecurityAuditRequestId(req);
  const submitted = settingsPatchForAudit(body);
  const changedFields = Object.keys(submitted);
  let before: RechargeSettings;
  try {
    before = serializeRechargeSettingsForAdmin(await getRechargeSettings());
    await writeSecurityAudit(req, {
      event: 'recharge.settings.update',
      operator: { id: admin.id, email: admin.email, role: admin.role },
      target: { type: 'recharge_settings', id: 'global' },
      before,
      after: submitted,
      reason: 'admin_update',
      outcome: 'ATTEMPTED',
      metadata: { changedFields },
      requestId,
    });
  } catch (err) {
    return auditUnavailable('充值配置更新前安全审计失败:', err);
  }

  // P3-10/P3-4：校验类失败（布尔字段收到非布尔、Stripe 密钥与 webhook secret 模式不一致、
  // 非法币种码等）由 updateRechargeSettings 整批前置校验后抛出，且**一个字段不合法就整批不写**。
  // 不映射成 400 的话这些会以 500 冒出来 —— 行为仍是 fail-closed，但管理员看不出是自己填错了。
  try {
    await updateRechargeSettings(body);
    logAction(req, 'admin.recharge.settings.update', {
      user: admin,
      detail: `更新充值配置: ${Object.keys(body).join(', ')}`,
    });

    const settings = serializeRechargeSettingsForAdmin(await getRechargeSettings());
    try {
      await writeSecurityAudit(req, {
        event: 'recharge.settings.update',
        operator: { id: admin.id, email: admin.email, role: admin.role },
        target: { type: 'recharge_settings', id: 'global' },
        before,
        after: { settings, submitted },
        reason: 'admin_update',
        outcome: 'SUCCESS',
        metadata: { changedFields },
        requestId,
      });
    } catch (err) {
      return auditUnavailable('充值配置更新完成安全审计失败:', err);
    }
    return NextResponse.json({ settings });
  } catch (err) {
    // RechargeSettingsError is raised by the complete pre-write validation pass.
    // Any other failure can happen during the non-transactional Promise.all upserts or the
    // post-write reload, so conservatively record PARTIAL instead of inventing a clean failure.
    const outcome = err instanceof RechargeSettingsError ? 'FAILED' : 'PARTIAL';
    try {
      await writeSecurityAudit(req, {
        event: 'recharge.settings.update',
        operator: { id: admin.id, email: admin.email, role: admin.role },
        target: { type: 'recharge_settings', id: 'global' },
        before,
        after: submitted,
        reason: 'admin_update',
        outcome,
        metadata: {
          changedFields,
          errorType: err instanceof Error ? err.name : 'UnknownError',
          failureStage:
            outcome === 'PARTIAL' ? 'write_or_reload' : 'validation',
        },
        requestId,
      });
    } catch (auditErr) {
      return auditUnavailable('充值配置更新失败结果安全审计失败:', auditErr);
    }
    if (err instanceof RechargeSettingsError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
