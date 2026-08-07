import crypto from 'crypto';
import type {
  PaymentProvider,
  CreateChargeParams,
  CreateChargeResult,
  CallbackResult,
  CallbackAck,
} from '@/lib/payment/types';
import type { RechargeSettings } from '@/lib/payment/settings';

/**
 * Stripe 渠道（Checkout Session + Webhook）。用 REST API 直连（不引入 stripe SDK 依赖）：
 *  - createCharge：POST /v1/checkout/sessions，返回 session.url 作为跳转支付页；
 *  - verifyCallback：校验 Stripe-Signature（HMAC-SHA256，webhook secret），解析
 *    checkout.session.completed 事件；out_trade_no 取自 client_reference_id。
 *
 * 测试模式可用测试卡（4242…）即时验真，无需真钱。币种由充值配置显式给出（P3-15）。
 */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private readonly secretKey: string;
  private readonly webhookSecret: string;

  constructor(s: RechargeSettings) {
    this.secretKey = s.stripeSecretKey;
    this.webhookSecret = s.stripeWebhookSecret;
  }

  async createCharge(params: CreateChargeParams): Promise<CreateChargeResult> {
    // P3-15：币种由 checkout 显式传入（来自充值配置的 ISO-4217 码），不再从货币符号猜。
    const currency = params.currency.trim().toLowerCase();
    if (!/^[a-z]{3}$/.test(currency)) {
      throw new Error(`Stripe createCharge: invalid currency ${params.currency}`);
    }
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('success_url', appendQuery(params.returnUrl, 'recharge', 'success'));
    form.set('cancel_url', appendQuery(params.returnUrl, 'recharge', 'cancel'));
    form.set('client_reference_id', params.outTradeNo);
    form.set('metadata[out_trade_no]', params.outTradeNo);
    form.set('line_items[0][price_data][currency]', currency);
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

    // 时间戳容差（防重放）：拒绝签名时间超过 5 分钟的通知。虽然到账 CAS 本身幂等，
    // 时效窗口仍是 Stripe 推荐的纵深防护。
    // P6-14：非数字必须**直接拒**。旧写法 `if (isFinite(t) && …)` 在 t 非数字时跳过整条
    // 新鲜度校验——极性写反。当前 t 进签名串使其不可达，但这是定时炸弹，别留。
    const tSec = Number(
      header.split(',').find((p) => p.trim().startsWith('t='))?.split('=')[1]
    );
    if (!Number.isFinite(tSec) || Math.abs(Date.now() / 1000 - tSec) > 300) {
      return null;
    }

    let event: {
      type?: string;
      livemode?: boolean;
      data?: {
        object?: {
          client_reference_id?: string;
          metadata?: Record<string, string>;
          payment_status?: string;
          amount_total?: number;
          currency?: string;
        };
      };
    };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return null;
    }

    // P3-4：live 密钥下只接受 livemode 事件。逐字段独立 upsert +「掩码=保持原值」使得
    // 「把 sk_test 换成 sk_live 但 webhook 密钥没换」是一次正常保存动作 → 生产环境里
    // 唯一验得过签名的反而是测试卡事件（真实支付因验签失败永远不到账）。
    if (this.secretKey.startsWith('sk_live_') && event.livemode !== true) return null;

    const obj = event.data?.object;
    if (!obj) return null;
    const outTradeNo = obj.client_reference_id || obj.metadata?.out_trade_no || '';

    // P3-16：退款 / 拒付 / 争议 → 反向流程（冻结权益 + 告警），绝不到账。
    // charge 对象上没有 client_reference_id，订单号只能从 metadata 取（createCharge 已写入）。
    // 拒付事件的 data.object 是 Dispute（自带 metadata，通常拿不到我方订单号）→ outTradeNo
    // 可能为空。此时仍标 reversal，由反向处理器记「无法定位订单」的告警，绝不静默吞掉。
    if (REVERSAL_EVENT_TYPES.has(event.type ?? '')) {
      return {
        outTradeNo,
        paid: false,
        reversal: true,
        currency: normalizeCurrency(obj.currency),
        rawStatus: event.type,
      };
    }

    if (!outTradeNo) return null;

    // checkout.session.completed 且 payment_status='paid' 视为成功。
    const paid =
      event.type === 'checkout.session.completed' && obj.payment_status === 'paid';
    // amount_total 为最小货币单位（分/cent），与订单 amountCents 同口径，供上层对账。
    const amountCents =
      typeof obj.amount_total === 'number' ? obj.amount_total : undefined;
    return {
      outTradeNo,
      paid,
      amountCents,
      // Stripe 回报的 currency 是小写码 → 统一成大写 ISO-4217 供上层比二元组（P3-15）。
      currency: normalizeCurrency(obj.currency),
      rawStatus: event.type,
    };
  }

  callbackAck(ok: boolean): CallbackAck {
    // P3-3：Stripe **看 HTTP 状态码**判定投递是否成功。默认实现两个分支都回 200 →
    // 验签失败/金额不符/发放失败一律被判「已送达」，永不重试，钱静默消失。
    // 失败必须回 5xx 让 Stripe 按自己的退避重投（最长 3 天）。
    return ok
      ? { body: 'success', contentType: 'text/plain', status: 200 }
      : { body: 'fail', contentType: 'text/plain', status: 500 };
  }
}

/**
 * 需要走反向流程的 Stripe 事件类型（退款 / 争议）。
 * 刻意只收「已发生」的两个：`charge.refund.updated` 之类可能描述一次**失败**的退款，
 * 据此冻结权益会误伤。
 */
const REVERSAL_EVENT_TYPES = new Set(['charge.refunded', 'charge.dispute.created']);

function normalizeCurrency(v: string | undefined): string | undefined {
  return v ? v.trim().toUpperCase() : undefined;
}

function appendQuery(url: string, key: string, value: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${key}=${encodeURIComponent(value)}`;
}

/**
 * 校验 Stripe-Signature 头：形如 `t=时间戳,v1=签名[,v1=签名…]`。signedPayload = `${t}.${rawBody}`，
 * 期望签名 = HMAC-SHA256(webhookSecret, signedPayload)。用 timingSafeEqual 防时序侧信道。
 *
 * L19：**每个 v1 都要比**，命中任一即通过。轮换 endpoint secret 期间 Stripe 会同时带上
 * 新旧两个 v1，旧实现「取首个即可」会把真实回调按序拒掉（方向是拒真、不是收伪）。
 * 导出供单测。
 */
export function verifyStripeSignature(
  rawBody: string,
  sigHeader: string,
  webhookSecret: string
): boolean {
  let t: string | undefined;
  const v1List: string[] = [];
  for (const kv of sigHeader.split(',')) {
    const idx = kv.indexOf('=');
    if (idx <= 0) continue;
    const k = kv.slice(0, idx).trim();
    const v = kv.slice(idx + 1).trim();
    if (!v) continue;
    if (k === 't' && t === undefined) t = v;
    else if (k === 'v1') v1List.push(v);
  }
  if (!t || v1List.length === 0) return false;
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(`${t}.${rawBody}`, 'utf8')
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  return v1List.some((v1) => {
    const b = Buffer.from(v1, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}
