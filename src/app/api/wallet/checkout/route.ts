import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getSiteSettings } from '@/lib/siteSettings';
import { getRechargeSettings } from '@/lib/payment/settings';
import { getPaymentProvider } from '@/lib/payment';
import { isPaymentProviderName } from '@/lib/payment/types';
import { createPaymentOrder, spendFromBalance, WalletError } from '@/lib/wallet';
import { enforceRateLimit } from '@/lib/rateLimit';

interface CheckoutInput {
  tierId?: string;
  mode?: 'balance' | 'pay';
  provider?: string;
}

// 发起充值/购买：mode='balance' 用余额买档位；mode='pay' 走支付渠道下单
export async function POST(req: Request) {
  const payload = await verifyAuth(req);
  if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const limited = await enforceRateLimit(req, {
    scope: 'wallet:checkout',
    limit: 20,
    windowMs: 60_000,
    key: `user:${payload.id}`,
  });
  if (limited) return limited;

  const settings = await getRechargeSettings();
  if (!settings.enabled) {
    return NextResponse.json({ error: '充值系统未开启' }, { status: 403 });
  }

  let body: CheckoutInput;
  try {
    body = (await req.json()) as CheckoutInput;
  } catch {
    return NextResponse.json({ error: '请求体无效' }, { status: 400 });
  }
  if (!body.tierId) return NextResponse.json({ error: '缺少档位' }, { status: 400 });

  const tier = await prisma.rechargeTier.findUnique({ where: { id: body.tierId } });
  if (!tier || !tier.active) {
    return NextResponse.json({ error: '档位不存在或已下架' }, { status: 400 });
  }

  // 用余额直接购买（会员/时间；topup 档位不可用余额买）
  if (body.mode === 'balance') {
    if (tier.kind === 'topup') {
      return NextResponse.json({ error: '充值档位需通过支付渠道购买' }, { status: 400 });
    }
    try {
      await spendFromBalance(payload.id, tier.id);
    } catch (err) {
      if (err instanceof WalletError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
      }
      console.error('余额购买失败:', err);
      return NextResponse.json({ error: '购买失败' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, mode: 'balance' });
  }

  // 走支付渠道下单
  const providerName = body.provider ?? '';
  if (!isPaymentProviderName(providerName)) {
    return NextResponse.json({ error: '支付渠道无效' }, { status: 400 });
  }
  const provider = await getPaymentProvider(providerName, settings);
  if (!provider) {
    return NextResponse.json({ error: '该支付渠道不可用' }, { status: 400 });
  }

  const site = await getSiteSettings();
  const base = (site.site_url || 'http://localhost:3000').replace(/\/+$/, '');
  const notifyUrl = `${base}/api/wallet/callback/${providerName}`;
  const returnUrl = `${base}/home`;
  const kind: 'topup' | 'purchase' = tier.kind === 'topup' ? 'topup' : 'purchase';

  const order = await createPaymentOrder({
    userId: payload.id,
    provider: providerName,
    kind,
    amountCents: tier.priceCents,
    tierId: kind === 'purchase' ? tier.id : undefined,
    creditCents: tier.kind === 'topup' ? tier.creditCents ?? tier.priceCents : undefined,
    returnUrl,
    subject: tier.name,
    // 冻结发放快照：回调结算按此发放，不再读 live 档位（H1 档位删/停不致退单、H2 冻结价防漂移）。
    grant:
      kind === 'purchase'
        ? {
            kind: tier.kind === 'membership' ? 'membership' : 'minutes',
            priceCents: tier.priceCents,
            tierId: tier.id,
            tierName: tier.name,
            grantRole: tier.grantRole,
            durationDays: tier.durationDays,
            grantMinutes: tier.grantMinutes,
          }
        : undefined,
  });

  try {
    const charge = await provider.createCharge({
      outTradeNo: order.outTradeNo,
      amountCents: order.amountCents,
      subject: tier.name,
      returnUrl,
      notifyUrl,
    });
    return NextResponse.json({
      ok: true,
      mode: 'pay',
      provider: providerName,
      outTradeNo: order.outTradeNo,
      payUrl: charge.payUrl ?? null,
      qrCode: charge.qrCode ?? null,
    });
  } catch (err) {
    console.error('发起支付失败:', err);
    await prisma.paymentOrder
      .update({ where: { id: order.id }, data: { status: 'failed' } })
      .catch(() => {});
    return NextResponse.json({ error: '发起支付失败' }, { status: 502 });
  }
}
