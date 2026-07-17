import crypto from 'crypto';
import type {
  PaymentProvider,
  CreateChargeParams,
  CreateChargeResult,
  CallbackResult,
} from '@/lib/payment/types';
import type { RechargeSettings } from '@/lib/payment/settings';

/**
 * Stripe 渠道（Checkout Session + Webhook）。用 REST API 直连（不引入 stripe SDK 依赖）：
 *  - createCharge：POST /v1/checkout/sessions，返回 session.url 作为跳转支付页；
 *  - verifyCallback：校验 Stripe-Signature（HMAC-SHA256，webhook secret），解析
 *    checkout.session.completed 事件；out_trade_no 取自 client_reference_id。
 *
 * 测试模式可用测试卡（4242…）即时验真，无需真钱。currency 由货币符号推导（¥→cny，$→usd）。
 */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly currency: string;

  constructor(s: RechargeSettings) {
    this.secretKey = s.stripeSecretKey;
    this.webhookSecret = s.stripeWebhookSecret;
    this.currency = symbolToStripeCurrency(s.currencySymbol);
  }

  async createCharge(params: CreateChargeParams): Promise<CreateChargeResult> {
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('success_url', appendQuery(params.returnUrl, 'recharge', 'success'));
    form.set('cancel_url', appendQuery(params.returnUrl, 'recharge', 'cancel'));
    form.set('client_reference_id', params.outTradeNo);
    form.set('metadata[out_trade_no]', params.outTradeNo);
    form.set('line_items[0][price_data][currency]', this.currency);
    form.set('line_items[0][price_data][product_data][name]', params.subject);
    // unit_amount 为最小货币单位（分/cent），与我们存储的 amountCents 同口径。
    form.set('line_items[0][price_data][unit_amount]', String(params.amountCents));
    form.set('line_items[0][quantity]', '1');

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const data = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
    if (!res.ok || !data.url) {
      throw new Error(`Stripe createCharge failed: ${data.error?.message ?? res.status}`);
    }
    return { payUrl: data.url, providerRef: data.id };
  }

  async verifyCallback(req: Request, rawBody: string): Promise<CallbackResult | null> {
    const header = req.headers.get('stripe-signature');
    if (!header || !this.webhookSecret) return null;
    if (!verifyStripeSignature(rawBody, header, this.webhookSecret)) return null;

    let event: {
      type?: string;
      data?: { object?: { client_reference_id?: string; metadata?: Record<string, string>; payment_status?: string } };
    };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const obj = event.data?.object;
    if (!obj) return null;
    const outTradeNo = obj.client_reference_id || obj.metadata?.out_trade_no || '';
    if (!outTradeNo) return null;

    // checkout.session.completed 且 payment_status='paid' 视为成功。
    const paid =
      event.type === 'checkout.session.completed' && obj.payment_status === 'paid';
    return { outTradeNo, paid, rawStatus: event.type };
  }
}

function symbolToStripeCurrency(symbol: string): string {
  if (symbol.includes('¥') || symbol.includes('￥')) return 'cny';
  if (symbol.includes('$')) return 'usd';
  if (symbol.includes('€')) return 'eur';
  if (symbol.includes('£')) return 'gbp';
  return 'usd';
}

function appendQuery(url: string, key: string, value: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${key}=${encodeURIComponent(value)}`;
}

/**
 * 校验 Stripe-Signature 头：形如 `t=时间戳,v1=签名`。signedPayload = `${t}.${rawBody}`，
 * 期望签名 = HMAC-SHA256(webhookSecret, signedPayload)。用 timingSafeEqual 防时序侧信道。
 * 导出供单测。
 */
export function verifyStripeSignature(
  rawBody: string,
  sigHeader: string,
  webhookSecret: string
): boolean {
  const parts = sigHeader.split(',').reduce<Record<string, string>>((acc, kv) => {
    const [k, v] = kv.split('=');
    if (k && v) {
      // 同名 key（可能多个 v1）取首个即可
      if (!(k.trim() in acc)) acc[k.trim()] = v.trim();
    }
    return acc;
  }, {});
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) return false;
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(`${t}.${rawBody}`, 'utf8')
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
