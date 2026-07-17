import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getWalletSummary } from '@/lib/wallet';
import { getRechargeSettings, toPublicRechargeConfig } from '@/lib/payment/settings';

// 用户钱包概览：余额 + 永久时长池 + 会员到期 + 公开充值配置（货币/已启用渠道）
export async function GET(req: Request) {
  const payload = await verifyAuth(req);
  if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [wallet, settings] = await Promise.all([
    getWalletSummary(payload.id),
    getRechargeSettings(),
  ]);
  if (!wallet) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  return NextResponse.json({
    wallet,
    config: toPublicRechargeConfig(settings),
  });
}
