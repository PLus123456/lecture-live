import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { withRequestLogging } from '@/lib/requestLogger';
import {
  getRechargeSettings,
  updateRechargeSettings,
  serializeRechargeSettingsForAdmin,
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

  await updateRechargeSettings(body);
  logAction(req, 'admin.recharge.settings.update', {
    user: admin ?? undefined,
    detail: `更新充值配置: ${Object.keys(body).join(', ')}`,
  });

  const settings = await getRechargeSettings();
  return NextResponse.json({ settings: serializeRechargeSettingsForAdmin(settings) });
});
