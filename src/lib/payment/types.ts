// 充值系统：支付适配层的统一契约。
// 各支付渠道（支付宝 / 微信 / Stripe / sandbox）实现同一 PaymentProvider 接口，
// 上层 checkout / callback 路由与钱包结算（wallet.ts）不感知具体渠道差异。

export type PaymentProviderName = 'alipay' | 'wechat' | 'stripe' | 'sandbox';

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
}

/** 发起支付的结果：跳转 URL 或扫码内容，二选一（或都给）。 */
export interface CreateChargeResult {
  /** 跳转支付页 URL（支付宝电脑网站支付 / Stripe Checkout / sandbox 确认页）。 */
  payUrl?: string;
  /** 扫码支付二维码内容（微信 Native / 支付宝当面付）。前端渲染成二维码。 */
  qrCode?: string;
  /** 网关侧订单号/流水号（审计，可空）。 */
  providerRef?: string;
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
  /** 网关侧订单号/流水号（审计）。 */
  providerRef?: string;
  /** 网关原始状态串（审计/排障）。 */
  rawStatus?: string;
}

/** 回调应答（不同网关要求不同的 ACK 响应体）。 */
export interface CallbackAck {
  body: string;
  contentType: string;
  status?: number;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
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
