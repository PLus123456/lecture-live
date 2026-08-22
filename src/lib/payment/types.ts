// 充值系统：支付适配层的统一契约。
// 各支付渠道（支付宝 / 微信 / Stripe / sandbox）实现同一 PaymentProvider 接口，
// 上层 checkout / callback 路由与钱包结算（wallet.ts）不感知具体渠道差异。

export type PaymentProviderName = 'alipay' | 'wechat' | 'stripe' | 'sandbox';
export type PaymentProviderMode = 'live' | 'test' | 'sandbox' | 'unknown';

/** A typed gateway object reference used for durable event-to-order correlation. */
export interface PaymentObjectRef {
  objectType: string;
  objectId: string;
}

export const PAYMENT_PROVIDER_NAMES: PaymentProviderName[] = [
  'alipay',
  'wechat',
  'stripe',
  'sandbox',
];

export function isPaymentProviderName(v: string): v is PaymentProviderName {
  return (PAYMENT_PROVIDER_NAMES as string[]).includes(v);
}

/** 发起一笔支付所需参数（由 checkout 路由构造）。 */
export interface CreateChargeParams {
  /** 我方订单号（PaymentOrder.outTradeNo，唯一），传给网关、回调据此认领。 */
  outTradeNo: string;
  /** 应付金额（分）。 */
  amountCents: number;
  /** 订单标题（展示给用户）。 */
  subject: string;
  /** 支付完成后浏览器跳回地址（同步跳转）。 */
  returnUrl: string;
  /** 网关异步通知回调地址（服务端到服务端；验签为唯一信任源）。 */
  notifyUrl: string;
  /**
   * ISO-4217 币种码（大写，如 'CNY'），由 checkout 从充值配置读出后传入（P3-15）。
   * 从前 Stripe 由「货币符号」猜币种、猜不出就 `return 'usd'`：管理员填「元」即静默按美元
   * 收款、约 7.1× 超收。币种必须是显式配置项，绝不可从展示用符号反推。
   */
  currency: string;
}

/** 发起支付的结果：跳转 URL 或扫码内容，二选一（或都给）。 */
export interface CreateChargeResult {
  /** 跳转支付页 URL（支付宝电脑网站支付 / Stripe Checkout / sandbox 确认页）。 */
  payUrl?: string;
  /** 扫码支付二维码内容（微信 Native / 支付宝当面付）。前端渲染成二维码。 */
  qrCode?: string;
  /** 网关侧订单号/流水号（审计，可空）。 */
  providerRef?: string;
  /** 订单创建时已知的 typed gateway objects（Stripe 初始通常只有 Checkout Session）。 */
  objectRefs?: PaymentObjectRef[];
}

/** 解析并验签网关异步通知后的归一化结果。 */
export interface CallbackResult {
  /** 我方订单号（从通知里取，用于认领 PaymentOrder）。 */
  outTradeNo: string;
  /** 是否已支付成功。 */
  paid: boolean;
  /**
   * 网关回报的**实付金额（分）**，用于与订单金额对账（M1/M2）。上层 creditPaidOrder 若发现与
   * PaymentOrder.amountCents 不一致则拒绝到账。渠道无法给出金额（如 sandbox）时留空 → 跳过对账。
   */
  amountCents?: number;
  /**
   * 网关回报的 ISO-4217 币种码（大写）。与 amountCents 成对使用：上层 creditPaidOrder 比
   * (amount, currency) 二元组，只比金额挡不住跨币种套利（P3-15）。渠道给不出时留空 → 跳过。
   */
  currency?: string;
  /**
   * 退款 / 拒付 / 争议类通知（P3-16）。为 true 时回调路由走反向流程（冻结权益 + 告警），
   * 绝不到账。与 paid 互斥：反向通知的 paid 恒为 false。
   */
  reversal?: boolean;
  /** 网关回报的退款/争议金额；Stripe 退款为累计 amount_refunded。 */
  reversalAmountCents?: number;
  /** true 才证明整单反向；false 表示部分退款，必须进入人工复核，绝不能全量撤权。 */
  fullReversal?: boolean;
  /**
   * Stripe refund/dispute lifecycle state. `pending` freezes value without guessing a final
   * clawback, `withdrawn` is a succeeded refund/lost dispute, and `reinstated` is a terminal
   * failed/canceled refund or won dispute that may release only the matching pending hold.
   */
  reversalState?: 'pending' | 'withdrawn' | 'reinstated';
  /**
   * 验签通过但**无需到账也无需重试**的通知（如微信的非交易类事件，P6-13）。
   * 回调路由据此回成功 ACK，避免网关按 15 次/24h 无限重推一条我们永远不会处理的通知。
   */
  acknowledged?: boolean;
  /** 网关侧订单号/流水号（审计）。 */
  providerRef?: string;
  /** 网关原始状态串（审计/排障）。 */
  rawStatus?: string;
  /** 网关稳定事件 ID；缺失渠道由上层对验签原文做 SHA-256 生成，不保存原文。 */
  eventId?: string;
  /** 事件种类（如 checkout.session.completed / REFUND.SUCCESS）。 */
  eventType?: string;
  /** live/test/sandbox 隔离维度；对象映射与 inbox 唯一键必须包含。 */
  providerMode?: PaymentProviderMode;
  /** 商户/Connect 账户隔离维度（appId/mchId/acct_*）；绝不放密钥。 */
  providerAccount?: string;
  /** 网关签名事件中的业务发生时间；支付过期状态机使用它，而非回调到达时间。 */
  occurredAt?: Date;
  /** 本事件携带的 Checkout Session / PaymentIntent / Charge / Dispute 等引用。 */
  objectRefs?: PaymentObjectRef[];
}

/** 回调应答（不同网关要求不同的 ACK 响应体）。 */
export interface CallbackAck {
  body: string;
  contentType: string;
  status?: number;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** 创建订单时可确定的网关命名空间。 */
  readonly mode?: PaymentProviderMode;
  readonly account?: string;
  /** 发起一笔支付。凭据缺失/配置非法应抛错（checkout 路由捕获并回 4xx/5xx）。 */
  createCharge(params: CreateChargeParams): Promise<CreateChargeResult>;
  /**
   * 解析并**验签**网关异步通知。rawBody 为原始请求体（验签往往需要原文）。
   * 返回 null = 验签失败/无法解析 → 调用方必须拒绝，绝不据此到账（防伪造回调白嫖）。
   */
  verifyCallback(req: Request, rawBody: string): Promise<CallbackResult | null>;
  /** 网关要求的回调应答体（如支付宝要回纯文本 "success"）。默认见 defaultCallbackAck。 */
  callbackAck?(ok: boolean): CallbackAck;
}

/** 多数网关：成功回 "success"、失败回 "fail"（纯文本）。 */
export function defaultCallbackAck(ok: boolean): CallbackAck {
  return { body: ok ? 'success' : 'fail', contentType: 'text/plain', status: 200 };
}
