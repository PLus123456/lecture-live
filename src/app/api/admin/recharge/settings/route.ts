import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { withRequestLogging } from '@/lib/requestLogger';
import {
  getRechargeSettings,
  updateRechargeSettings,
  serializeRechargeSettingsForAdmin,
  RechargeSettingsError,
  type RechargeSettings,
} from '@/lib/payment/settings';

// 获取充值配置（敏感凭据脱敏）
export const GET = withRequestLogging('admin:recharge:settings:get', async (req: Request) => {
  const { response } = await requireAdminAccess(req, { scope: 'admin:recharge:settings:get' });
  if (response) return response;
  const settings = await getRechargeSettings();
  return NextResponse.json({ settings: serializeRechargeSettingsForAdmin(settings) });
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

  // P3-10/P3-4：校验类失败（布尔字段收到非布尔、Stripe 密钥与 webhook secret 模式不一致、
  // 非法币种码等）由 updateRechargeSettings 整批前置校验后抛出，且**一个字段不合法就整批不写**。
  // 不映射成 400 的话这些会以 500 冒出来 —— 行为仍是 fail-closed，但管理员看不出是自己填错了。
  try {
    await updateRechargeSettings(body);
  } catch (err) {
    if (err instanceof RechargeSettingsError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  logAction(req, 'admin.recharge.settings.update', {
    user: admin ?? undefined,
    detail: `更新充值配置: ${Object.keys(body).join(', ')}`,
  });

  const settings = await getRechargeSettings();
  return NextResponse.json({ settings: serializeRechargeSettingsForAdmin(settings) });
});
