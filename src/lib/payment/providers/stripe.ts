import crypto from 'crypto';
import type {
  PaymentProvider,
  CreateChargeParams,
  CreateChargeResult,
  CallbackResult,
  CallbackAck,
  PaymentProviderMode,
} from '@/lib/payment/types';
import type { RechargeSettings } from '@/lib/payment/settings';
import {
  getStripeKeyMode,
  isStripeEventModeAllowed,
  isStripeKeyAllowedForEnvironment,
} from '@/lib/payment/stripeMode';

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
  readonly mode: PaymentProviderMode;
  readonly account = 'default';
  private readonly secretKey: string;
  private readonly webhookSecret: string;

  constructor(s: RechargeSettings) {
    this.secretKey = s.stripeSecretKey;
    this.webhookSecret = s.stripeWebhookSecret;
    this.mode = getStripeKeyMode(this.secretKey) ?? 'unknown';
  }

  async createCharge(params: CreateChargeParams): Promise<CreateChargeResult> {
    // SEC-024 纵深门禁：即使调用方绕过 provider 装配，生产 test/未知 key 也不得发起下单。
    if (!isStripeKeyAllowedForEnvironment(this.secretKey)) {
      throw new Error('Stripe createCharge: production requires a live mode key');
    }

    // P3-15：币种由 checkout 显式传入（来自充值配置的 ISO-4217 码），不再从货币符号猜。
    const currency = params.currency.trim().toLowerCase();
    if (!/^[a-z]{3}$/.test(currency)) {
      throw new Error(`Stripe createCharge: invalid currency ${params.currency}`);
    }
    // 审计 #7 纵深门禁：amountCents 恒按 1/100 计、unit_amount 原样透传。零位小数币种（JPY 等）在
    // Stripe 侧以整单位计 → 按显示价 100 倍收款；三位小数币种（KWD 等）→ 只收 1/10。配置保存侧已拒，
    // 这里兜住保存校验上线前就已落库的历史配置：宁可下单失败，也不按错位的单位扣用户的钱。
    if (!isCentDenominatedCurrency(currency)) {
      throw new Error(
        `Stripe createCharge: ${currency.toUpperCase()} is not a two-decimal currency; amounts are stored in 1/100 units`
      );
    }
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('success_url', appendQuery(params.returnUrl, 'recharge', 'success'));
    form.set('cancel_url', appendQuery(params.returnUrl, 'recharge', 'cancel'));
    form.set('client_reference_id', params.outTradeNo);
    form.set('metadata[out_trade_no]', params.outTradeNo);
    // Checkout Session metadata is not sufficient for charge.refunded/dispute correlation.
    // Copy our immutable order number to the PaymentIntent so downstream Charge/Dispute
    // objects can carry or be linked back to the same order.
    form.set('payment_intent_data[metadata][out_trade_no]', params.outTradeNo);
    form.set('line_items[0][price_data][currency]', currency);
    form.set('line_items[0][price_data][product_data][name]', params.subject);
    // unit_amount 为最小货币单位（分/cent），与我们存储的 amountCents 同口径。
    form.set('line_items[0][price_data][unit_amount]', String(params.amountCents));
    form.set('line_items[0][quantity]', '1');
    // 让 Stripe 自己在同一时刻关闭会话。不设的话 Checkout 默认 24 小时有效，用户在
    // 我方 expiresAt 之后付款会被 creditPaidOrder 判 late_paid —— 钱进了 Stripe，
    // 权益一分不发。Stripe 要求 expires_at 至少为 30 分钟后（ORDER_TTL_MS 取 60 分钟）。
    form.set(
      'expires_at',
      String(Math.floor(params.expiresAt.getTime() / 1000))
    );

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
    return {
      payUrl: data.url,
      providerRef: data.id,
      objectRefs: data.id
        ? [{ objectType: 'checkout_session', objectId: data.id }]
        : undefined,
    };
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
      id?: string;
      type?: string;
      livemode?: boolean;
      account?: string;
      created?: number;
      data?: {
        object?: {
          id?: string;
          object?: string;
          client_reference_id?: string;
          metadata?: Record<string, string>;
          payment_status?: string;
          status?: string;
          amount_total?: number;
          amount_received?: number;
          amount?: number;
          amount_refunded?: number;
          refunded?: boolean;
          currency?: string;
          created?: number;
          expires_at?: number;
          payment_intent?: string | { id?: string };
          latest_charge?: string | { id?: string };
          charge?: string | { id?: string };
        };
      };
    };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return null;
    }

    // SEC-024：签名体中的 livemode 必须与 sk/rk key 模式同侧；生产更只接受 live/live。
    // 这同时封住「live API key + test webhook secret」以及直接在生产装配 test key 的路径。
    if (!isStripeEventModeAllowed(this.secretKey, event.livemode)) return null;

    const obj = event.data?.object;
    if (!obj) return null;
    const outTradeNo = obj.client_reference_id || obj.metadata?.out_trade_no || '';
    const providerMode = event.livemode === true ? 'live' : 'test';
    const providerAccount = event.account?.trim() || 'default';
    const primaryObjectType = normalizeStripeObjectType(obj.object, obj.id, event.type);
    const paymentIntentId = objectId(obj.payment_intent);
    const chargeId = objectId(obj.charge) || objectId(obj.latest_charge);
    const objectRefs = uniqueObjectRefs([
      obj.id && primaryObjectType
        ? { objectType: primaryObjectType, objectId: obj.id }
        : null,
      paymentIntentId
        ? { objectType: 'payment_intent', objectId: paymentIntentId }
        : null,
      chargeId ? { objectType: 'charge', objectId: chargeId } : null,
    ]);
    const occurredAt =
      typeof event.created === 'number' && Number.isFinite(event.created)
        ? new Date(event.created * 1000)
        : undefined;

    // P3-16：退款 / 拒付 / 争议 → 反向流程（冻结权益 + 告警），绝不到账。
    // charge 对象上没有 client_reference_id，订单号只能从 metadata 取（createCharge 已写入）。
    // 拒付事件的 data.object 是 Dispute（自带 metadata，通常拿不到我方订单号）→ outTradeNo
    // 可能为空。此时仍标 reversal，由反向处理器记「无法定位订单」的告警，绝不静默吞掉。
    const eventType = event.type ?? '';
    const lifecycle = stripeReversalLifecycle(eventType, obj.status);
    if (lifecycle) {
      const refundResource = REFUND_RESOURCE_EVENT_TYPES.has(eventType);
      const reversalAmountCents =
        eventType === 'charge.refunded'
          ? obj.amount_refunded
          : obj.amount;
      const fullReversal =
        eventType === 'charge.refunded'
          ? obj.refunded === true &&
            Number.isSafeInteger(obj.amount) &&
            Number.isSafeInteger(obj.amount_refunded) &&
            obj.amount_refunded === obj.amount
          : lifecycle === 'pending'
            ? false
            : undefined;
      const reversal = lifecycle !== 'reinstated';
      return {
        outTradeNo,
        paid: false,
        reversal,
        reversalAmountCents,
        fullReversal,
        reversalState: lifecycle,
        ...(lifecycle === 'reinstated' ? { acknowledged: true } : {}),
        currency: normalizeCurrency(obj.currency),
        providerRef: obj.id,
        rawStatus: `${eventType}:${obj.status ?? (refundResource ? 'unknown' : 'unknown')}`,
        eventId: event.id,
        eventType,
        providerMode,
        providerAccount,
        occurredAt,
        objectRefs,
      };
    }

    const knownHarmlessNoop =
      HARMLESS_NOOP_EVENT_TYPES.has(eventType) ||
      (eventType === 'checkout.session.completed' && obj.payment_status !== 'paid');

    // A signed event with no local reference is still returned so the route can durably retain
    // and review it. Only a narrowly enumerated terminal/no-op type may carry `acknowledged`;
    // treating every future Stripe type as harmless would silently ACK new reversal semantics.
    if (!outTradeNo) {
      return {
        outTradeNo: '',
        paid: false,
        ...(knownHarmlessNoop ? { acknowledged: true } : {}),
        providerRef: obj.id,
        rawStatus: event.type,
        eventId: event.id,
        eventType: event.type,
        providerMode,
        providerAccount,
        occurredAt,
        objectRefs,
      };
    }

    // Checkout 的延迟支付方式会先发 completed(unpaid)，之后再发
    // async_payment_succeeded。PaymentIntent 成功事件也是可靠的备用结算源；三者都要求
    // 明确的 paid/succeeded 状态，未知值不猜测。
    const paid =
      ((event.type === 'checkout.session.completed' ||
        event.type === 'checkout.session.async_payment_succeeded') &&
        obj.payment_status === 'paid') ||
      (event.type === 'payment_intent.succeeded' && obj.status === 'succeeded');
    // amount_total 为最小货币单位（分/cent），与订单 amountCents 同口径，供上层对账。
    const amountCents =
      typeof obj.amount_total === 'number'
        ? obj.amount_total
        : typeof obj.amount_received === 'number'
          ? obj.amount_received
          : typeof obj.amount === 'number'
            ? obj.amount
            : undefined;
    return {
      outTradeNo,
      paid,
      amountCents,
      // Stripe 回报的 currency 是小写码 → 统一成大写 ISO-4217 供上层比二元组（P3-15）。
      currency: normalizeCurrency(obj.currency),
      providerRef: obj.id,
      rawStatus: event.type,
      eventId: event.id,
      eventType: event.type,
      providerMode,
      providerAccount,
      // 审计 #4：已付事件报「顾客承诺付款」的时刻，而不是延迟支付方式数日后的到账时刻（见下方函数）。
      occurredAt: paid ? stripePaymentCommittedAt(event.type, obj, occurredAt) : occurredAt,
      objectRefs,
      // Only explicitly understood terminal/no-op events are safe to ACK.
      ...(!paid && knownHarmlessNoop ? { acknowledged: true } : {}),
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

/** Stripe refund/dispute lifecycle events. Pending states freeze; terminal states settle them. */
const REFUND_RESOURCE_EVENT_TYPES = new Set([
  'refund.created',
  'refund.failed',
  'refund.updated',
  'charge.refund.updated',
]);
const DISPUTE_EVENT_TYPES = new Set([
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
]);

function stripeReversalLifecycle(
  eventType: string,
  objectStatus: string | undefined
): 'pending' | 'withdrawn' | 'reinstated' | null {
  if (eventType === 'charge.refunded') return 'withdrawn';
  if (REFUND_RESOURCE_EVENT_TYPES.has(eventType)) {
    if (objectStatus === 'succeeded') return 'withdrawn';
    if (objectStatus === 'failed' || objectStatus === 'canceled') return 'reinstated';
    return 'pending';
  }
  if (DISPUTE_EVENT_TYPES.has(eventType)) {
    if (objectStatus === 'lost') return 'withdrawn';
    if (
      objectStatus === 'won' ||
      objectStatus === 'warning_closed' ||
      eventType === 'charge.dispute.funds_reinstated'
    ) {
      return 'reinstated';
    }
    return 'pending';
  }
  return null;
}

/** Signed Stripe events whose terminal semantics cannot grant or revoke local value. */
const HARMLESS_NOOP_EVENT_TYPES = new Set([
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.canceled',
  'payment_intent.payment_failed',
]);

function objectId(value: string | { id?: string } | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.id;
}

/**
 * 审计 #4：已付事件交给 creditPaidOrder 过期闸（paidAt >= expiresAt → late_paid）的时刻。
 *
 * event.created 是**事件**生成时刻。卡类同步支付它≈付款时刻；但延迟到账支付方式（SEPA / ACH /
 * Konbini / 银行转账…）的顾客是在 expires_at 之前完成 Checkout（completed + payment_status=unpaid，
 * 按无害事件 ACK），资金数日后才到账，届时才发 checkout.session.async_payment_succeeded /
 * payment_intent.succeeded —— 原样拿 event.created 当 paidAt，这类支付**每一笔**都会被判
 * late_paid：钱收了、权益一分不发，且没有任何后台动作能补发。
 *
 * 过期闸真正要问的是「顾客是否在订单有效期内承诺付款」，所以取 Stripe 自己能证明的承诺时刻作上界：
 *  - Checkout Session（status=complete）：过期的会话无法再完成，complete 本身就证明完成发生在
 *    expires_at 之前 → min(event.created, expires_at − 1s)。expires_at 由 createCharge 按订单
 *    expiresAt（已取整到秒）下发，故 expires_at − 1s 恒早于订单 expiresAt；
 *  - PaymentIntent：created 是确认（新版 API 惰性创建）或会话创建（旧版）时刻，都不晚于承诺付款
 *    → min(event.created, pi.created)。
 * 证据字段缺失 / 非数字时原样返回 event.created（维持旧口径：拿不准就落 late_paid 交人工复核）。
 * 只把时刻往前收、绝不往后推；两个上界都不早于建单（会话与 PI 都在订单落库之后才由 createCharge
 * 创建），所以不会误触「付款早于下单」那道闸（payment_before_order）。
 */
function stripePaymentCommittedAt(
  eventType: string | undefined,
  obj: { status?: string; created?: number; expires_at?: number },
  eventCreatedAt: Date | undefined
): Date | undefined {
  if (!eventCreatedAt) return eventCreatedAt;
  let boundSec: number | null = null;
  if (
    (eventType === 'checkout.session.completed' ||
      eventType === 'checkout.session.async_payment_succeeded') &&
    obj.status === 'complete' &&
    typeof obj.expires_at === 'number' &&
    Number.isFinite(obj.expires_at)
  ) {
    boundSec = obj.expires_at - 1;
  } else if (
    eventType === 'payment_intent.succeeded' &&
    typeof obj.created === 'number' &&
    Number.isFinite(obj.created)
  ) {
    boundSec = obj.created;
  }
  if (boundSec == null) return eventCreatedAt;
  const boundMs = boundSec * 1000;
  return boundMs < eventCreatedAt.getTime() ? new Date(boundMs) : eventCreatedAt;
}

/**
 * 审计 #7：最小货币单位**不是** 1/100 的 ISO-4217 币种（零位小数 + 三位小数，外加两种四位小数的
 * 记账单位）。本系统所有金额（priceCents / amountCents / walletBalanceCents）一律按 1/100 存储、
 * 展示（formatCurrencyCents 除以 100），并原样作为 Stripe 的 unit_amount 下发：
 *  - 零位小数（JPY、KRW…）在 Stripe 侧以整单位计 → 显示 ¥10.00 的档位实收 ¥1000（100 倍）；
 *  - 三位小数（KWD、BHD…）以 1/1000 计 → 只收显示价的 1/10。
 * 名单取 ISO-4217 与 Stripe 零位小数表的并集（含 Stripe 按零位小数处理的 MGA、特例 ISK）。
 * 支付宝 / 微信只收 CNY，自身已拒其它币种；需要防的只有 Stripe 这一条可配币种的通道。
 */
const NON_CENT_CURRENCIES: ReadonlySet<string> = new Set([
  // 零位小数
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'UYI',
  'VND', 'VUV', 'XAF', 'XOF', 'XPF',
  // 三位小数
  'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND',
  // 四位小数（记账单位）
  'CLF', 'UYW',
]);

/** 币种的最小货币单位是否为 1/100（本系统金额模型唯一支持的口径）。大小写不敏感。 */
export function isCentDenominatedCurrency(code: string): boolean {
  return !NON_CENT_CURRENCIES.has(code.trim().toUpperCase());
}

function normalizeStripeObjectType(
  declared: string | undefined,
  id: string | undefined,
  eventType: string | undefined
): string | undefined {
  if (declared === 'checkout.session') return 'checkout_session';
  if (declared) return declared.replace(/\./g, '_');
  if (id?.startsWith('cs_')) return 'checkout_session';
  if (id?.startsWith('pi_')) return 'payment_intent';
  if (id?.startsWith('ch_')) return 'charge';
  if (id?.startsWith('dp_')) return 'dispute';
  return eventType?.split('.')[0]?.replace(/\./g, '_');
}

function uniqueObjectRefs(
  refs: Array<{ objectType: string; objectId: string } | null>
): Array<{ objectType: string; objectId: string }> {
  const seen = new Set<string>();
  return refs.filter((ref): ref is { objectType: string; objectId: string } => {
    if (!ref) return false;
    const key = `${ref.objectType}:${ref.objectId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
