import { NextResponse } from 'next/server';
import { getPaymentProvider } from '@/lib/payment';
import { isPaymentProviderName, defaultCallbackAck } from '@/lib/payment/types';
import { creditPaidOrder } from '@/lib/wallet';
import { getSiteSettings } from '@/lib/siteSettings';
import { logSystemEvent } from '@/lib/auditLog';

/**
 * 支付渠道异步通知回调（公开端点，中间件放行）。鉴权由 provider.verifyCallback 的验签承担。
 *  - POST：真实网关服务端到服务端通知 → 验签 → 幂等到账 → 回网关要求的 ACK。
 *  - GET：沙箱确认页跳转（浏览器）→ 验签 → 到账 → 重定向回 returnUrl?recharge=success|cancel。
 */
async function handle(req: Request, providerName: string, isBrowserGet: boolean) {
  if (!isPaymentProviderName(providerName)) {
    return NextResponse.json({ error: 'unknown provider' }, { status: 400 });
  }
  const provider = await getPaymentProvider(providerName);
  if (!provider) {
    return NextResponse.json({ error: 'channel unavailable' }, { status: 400 });
  }

  const rawBody = isBrowserGet ? '' : await req.text();
  const result = await provider.verifyCallback(req, rawBody);
  if (!result) {
    // 验签失败/无法解析：拒绝，绝不到账。
    logSystemEvent('recharge.callback.verify_failed', `provider=${providerName}`);
    if (isBrowserGet) {
      return redirectBack(await returnBase(), 'failed');
    }
    const ack = (provider.callbackAck ?? defaultCallbackAck)(false);
    return new NextResponse(ack.body, {
      status: ack.status ?? 400,
      headers: { 'Content-Type': ack.contentType },
    });
  }

  let credit: Awaited<ReturnType<typeof creditPaidOrder>> | null = null;
  if (result.paid) {
    credit = await creditPaidOrder(result.outTradeNo, result.providerRef);
  }

  if (isBrowserGet) {
    const base = credit?.returnUrl || (await returnBase());
    return redirectBack(base, result.paid ? 'success' : 'cancel');
  }

  // 真实网关：到账成功（或本就已处理）才回成功 ACK，否则回失败让网关重试。
  const ok = result.paid && (credit?.ok ?? false);
  const ack = (provider.callbackAck ?? defaultCallbackAck)(ok);
  return new NextResponse(ack.body, {
    status: ack.status ?? 200,
    headers: { 'Content-Type': ack.contentType },
  });
}

async function returnBase(): Promise<string> {
  const site = await getSiteSettings();
  return `${(site.site_url || 'http://localhost:3000').replace(/\/+$/, '')}/home`;
}

function redirectBack(returnUrl: string, status: 'success' | 'cancel' | 'failed') {
  const sep = returnUrl.includes('?') ? '&' : '?';
  return NextResponse.redirect(`${returnUrl}${sep}recharge=${status}`);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  return handle(req, provider, false);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  return handle(req, provider, true);
}
