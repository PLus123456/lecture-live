import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getSiteSettings } from '@/lib/siteSettings';
import { getRechargeSettings } from '@/lib/payment/settings';
import { getPaymentProvider } from '@/lib/payment';
import { isPaymentProviderName } from '@/lib/payment/types';
import type { PaymentObjectRef, PaymentProviderMode } from '@/lib/payment/types';
import { linkPaymentProviderObjects } from '@/lib/payment/webhookInbox';
import { isPurchasableMembershipRole } from '@/lib/payment/tierPolicy';
import {
  createPaymentOrder,
  spendFromBalance,
  WalletError,
  DEFAULT_ORDER_CURRENCY,
  ORDER_TTL_MS,
} from '@/lib/wallet';
import { enforceRateLimit } from '@/lib/rateLimit';

interface CheckoutInput {
  tierId?: string;
  mode?: 'balance' | 'pay';
  provider?: string;
}

/**
 * 结算币种（P3-15）：只认充值配置里的 ISO-4217 字段，绝不从展示用的 currencySymbol 反推——
 * 管理员在符号框里填「元 / CNY / RMB」时 Stripe 会静默按美元收款（约 7.1× 超收）。
 * 读法带兜底：配置项缺失时回落 CNY，而不是让整条下单轨崩掉。
 */
function resolveCurrency(settings: unknown): string {
  const raw = (settings as { currency?: unknown } | null)?.currency;
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : DEFAULT_ORDER_CURRENCY;
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
  // 存量 ADMIN 档位或下单后端被绕过 UI 时都在建单/扣款前关闭失败。
  // null 沿用历史会员档默认 PRO 的兼容语义。
  if (
    tier.kind === 'membership' &&
    !isPurchasableMembershipRole(tier.grantRole ?? 'PRO')
  ) {
    return NextResponse.json({ error: '该会员档位不可购买' }, { status: 400 });
  }

  // 用余额直接购买（会员/时间；topup 档位不可用余额买）
  if (body.mode === 'balance') {
    if (tier.kind === 'topup') {
      return NextResponse.json({ error: '充值档位需通过支付渠道购买' }, { status: 400 });
    }
    // L13：余额结算没有幂等键（支付轨靠 outTradeNo @unique 兜底，这条轨不建订单行）。攻击者
    // 零收益（每次都真扣钱），但网络重发/双击会实打实扣两笔 —— 用「同用户同档位 10 秒 1 次」
    // 的去抖把重复提交挡在事务之外。不是真幂等，是止损。
    const duplicated = await enforceRateLimit(req, {
      scope: 'wallet:checkout:balance',
      limit: 1,
      windowMs: 10_000,
      key: `user:${payload.id}:tier:${tier.id}`,
    });
    if (duplicated) return duplicated;
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
  const currency = resolveCurrency(settings);
  const providerMode: PaymentProviderMode =
    provider.mode ?? (providerName === 'sandbox' ? 'sandbox' : 'unknown');
  const providerAccount = provider.account?.trim() || 'default';

  let order: Awaited<ReturnType<typeof createPaymentOrder>>;
  try {
    order = await createPaymentOrder({
      userId: payload.id,
      provider: providerName,
      providerMode,
      providerAccount,
      kind,
      amountCents: tier.priceCents,
      currency,
      tierId: kind === 'purchase' ? tier.id : undefined,
      creditCents: tier.kind === 'topup' ? tier.creditCents ?? tier.priceCents : undefined,
      returnUrl,
      subject: tier.name,
      // 冻结发放快照：回调结算按此发放，不再读 live 档位（H1/H2）。
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
  } catch (err) {
    if (err instanceof WalletError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
    }
    console.error('创建支付订单失败:', err);
    return NextResponse.json({ error: '创建支付订单失败' }, { status: 500 });
  }

  try {
    const charge = await provider.createCharge({
      outTradeNo: order.outTradeNo,
      amountCents: order.amountCents,
      subject: tier.name,
      returnUrl,
      notifyUrl,
      currency,
      // 与 creditPaidOrder 的 late_paid 判定共用同一个 expiresAt：网关先拒收，
      // 我方才不会出现「钱收了但权益不发」的单子。createPaymentOrder 恒会写这一列，
      // 兜底只为满足 schema 上的可空性。
      expiresAt: order.expiresAt ?? new Date(Date.now() + ORDER_TTL_MS),
    });
    // P3-14：网关侧流水号在这里就拿到了，从前直接丢掉 → Stripe 订单的 providerRef 恒 null，
    // 对账时手里只有我方单号，网关后台那笔对不上。回调里再补是补不齐的（回调可能永远不来）。
    if (charge.providerRef) {
      await prisma.paymentOrder.updateMany({
        where: { id: order.id, status: 'pending' },
        data: { providerRef: charge.providerRef },
      });
    }
    const objectRefs = charge.objectRefs ?? inferCreatedObjectRefs(providerName, charge.providerRef);
    await linkPaymentProviderObjects({
      provider: providerName,
      providerMode,
      providerAccount,
      orderId: order.id,
      objectRefs,
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
    // L16：裸 update 会把一笔**可能已在网关侧建单成功**的订单无条件打成终态 failed（歧义失败：
    // 请求超时但网关其实收下了）。加 status:'pending' 谓词——晚到的回调若已把它认领成 paid，
    // 这条就不再落地，钱不会因为一次超时而消失。
    await prisma.paymentOrder
      .updateMany({ where: { id: order.id, status: 'pending' }, data: { status: 'failed' } })
      .catch(() => {});
    return NextResponse.json({ error: '发起支付失败' }, { status: 502 });
  }
}

function inferCreatedObjectRefs(
  provider: string,
  providerRef: string | undefined
): PaymentObjectRef[] | undefined {
  if (!providerRef) return undefined;
  if (provider === 'stripe') {
    if (providerRef.startsWith('cs_')) {
      return [{ objectType: 'checkout_session', objectId: providerRef }];
    }
    if (providerRef.startsWith('pi_')) {
      return [{ objectType: 'payment_intent', objectId: providerRef }];
    }
  }
  return [{ objectType: 'provider_order', objectId: providerRef }];
}
