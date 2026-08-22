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
 * 支付宝渠道（电脑网站支付 alipay.trade.page.pay，RSA2 签名）。
 *  - createCharge：构造并 RSA2 签名请求参数，payUrl = 网关 + '?' + 编码后的参数（浏览器 GET 跳转）；
 *  - verifyCallback：异步通知（POST form）→ 用支付宝公钥验签 → trade_status 判定 → out_trade_no。
 *
 * 金额单位：支付宝以「元」为单位、两位小数；我们存储 amountCents（分）→ 除以 100。
 * 需你在支付宝开放平台配置应用私钥、上传应用公钥、下载支付宝公钥，并把回调地址设为 notify_url。
 */
/** 支付宝境内收单固定人民币（通知里也不带币种字段）。 */
const ALIPAY_CURRENCY = 'CNY';

export class AlipayProvider implements PaymentProvider {
  readonly name = 'alipay' as const;
  readonly mode: 'live' | 'test';
  readonly account: string;
  private readonly appId: string;
  private readonly sellerId: string;
  private readonly privateKeyPem: string;
  private readonly alipayPublicKeyPem: string;
  private readonly gateway: string;

  constructor(s: RechargeSettings) {
    this.appId = s.alipayAppId;
    this.account = this.appId.trim() || 'default';
    this.sellerId = (s.alipaySellerId || '').trim();
    this.privateKeyPem = wrapPem(s.alipayPrivateKey, 'PRIVATE KEY');
    this.alipayPublicKeyPem = wrapPem(s.alipayPublicKey, 'PUBLIC KEY');
    this.gateway = s.alipayGateway || 'https://openapi.alipay.com/gateway.do';
    this.mode = /alipaydev|sandbox/i.test(this.gateway) ? 'test' : 'live';
  }

  async createCharge(params: CreateChargeParams): Promise<CreateChargeResult> {
    // 支付宝境内收单只做人民币；币种不符必须当场炸，绝不静默按 CNY 收（P3-15）。
    if (params.currency !== ALIPAY_CURRENCY) {
      throw new Error(`Alipay only settles ${ALIPAY_CURRENCY}, got ${params.currency}`);
    }
    const bizContent = JSON.stringify({
      out_trade_no: params.outTradeNo,
      product_code: 'FAST_INSTANT_TRADE_PAY',
      total_amount: centsToYuan(params.amountCents),
      subject: params.subject,
    });
    const common: Record<string, string> = {
      app_id: this.appId,
      method: 'alipay.trade.page.pay',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: formatAlipayTimestamp(new Date()),
      version: '1.0',
      notify_url: params.notifyUrl,
      return_url: appendQuery(params.returnUrl, 'recharge', 'success'),
      biz_content: bizContent,
    };
    // 请求方向：sign_type **参与**签名（只有异步通知的 rsaCheckV1 才剔除它）。P3-1
    const signStr = buildSignString(common, { forRequest: true });
    const sign = crypto
      .createSign('RSA-SHA256')
      .update(signStr, 'utf8')
      .sign(this.privateKeyPem, 'base64');
    const query = Object.entries({ ...common, sign })
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return { payUrl: `${this.gateway}?${query}`, providerRef: params.outTradeNo };
  }

  async verifyCallback(req: Request, rawBody: string): Promise<CallbackResult | null> {
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(rawBody)) params[k] = v;
    const sign = params.sign;
    if (!sign) return null;
    if (!verifyAlipaySign(params, sign, this.alipayPublicKeyPem)) return null;

    // 验签通过后仍须校验业务字段（支付宝集成规范要求，M2）：app_id 必须是本应用，否则拒绝——
    // 防止用「攻击者自己支付宝应用」生成的合法签名通知（同一平台密钥可验签）来给我方订单冒充到账。
    // L17：缺 app_id 时**不能整条跳过**——那正好是冒充者最省事的构造（少填一个字段即免检）。
    if (this.appId && params.app_id !== this.appId) return null;
    // L17：seller_id（收款方商户 PID）已配置则必须匹配，同理不接受缺字段免检。
    if (this.sellerId && params.seller_id !== this.sellerId) return null;

    const outTradeNo = params.out_trade_no || '';
    if (!outTradeNo) return null;

    // P3-2：**退款类通知绝不能当到账**。部分退款的 trade_status 仍是 TRADE_SUCCESS，
    // 只看状态会让「钱已退、权益照发」的通知认领 pending 单 = 凭空造钱。
    // （全额退款走 TRADE_CLOSED，本就不在接受列表；TRADE_FINISHED 是「已收款且不可再退」，
    //   删掉它反而会丢弃真实已付订单——两处都别改错。）
    // 部分退款也一并标 reversal 走完整冻结：我们卖的是不可分割的权益（一期会员 / 一包分钟），
    // 没有「退一半权益」的语义；宁可冻结 + 告警让人工补偿，也不留一笔权益悬在半退款状态。
    const isRefund = Boolean(
      params.refund_fee || params.gmt_refund || params.out_biz_no
    );
    const paid =
      !isRefund &&
      (params.trade_status === 'TRADE_SUCCESS' ||
        params.trade_status === 'TRADE_FINISHED');
    // 支付宝金额以「元」计，两位小数 → 转分对账。
    const amountCents = params.total_amount
      ? Math.round(Number(params.total_amount) * 100)
      : undefined;
    return {
      outTradeNo,
      paid,
      ...(isRefund ? { reversal: true } : {}),
      ...(!isRefund && params.trade_status === 'WAIT_BUYER_PAY'
        ? { acknowledged: true }
        : {}),
      amountCents: Number.isFinite(amountCents) ? amountCents : undefined,
      // 支付宝境内收单恒为人民币，通知里不带币种字段。
      currency: ALIPAY_CURRENCY,
      providerRef: params.trade_no,
      rawStatus: params.trade_status,
      eventId: params.notify_id,
      eventType: isRefund ? 'trade.refund' : params.trade_status,
      providerMode: this.mode,
      providerAccount: this.account,
      occurredAt: parseAlipayDate(params.gmt_payment || params.notify_time),
      objectRefs: params.trade_no
        ? [{ objectType: 'transaction', objectId: params.trade_no }]
        : undefined,
    };
  }

  callbackAck(ok: boolean): CallbackAck {
    // 支付宝要求异步通知处理成功后回纯文本 "success"，否则会重试。
    return { body: ok ? 'success' : 'fail', contentType: 'text/plain', status: 200 };
  }
}

/** Alipay timestamps are documented in UTC+8 and omit an offset. */
function parseAlipayDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const millis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour) - 8,
    Number(minute),
    Number(second)
  );
  const parsed = new Date(millis);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

/** 分 → 元（两位小数字符串）。 */
function centsToYuan(cents: number): string {
  return (Math.max(0, Math.round(cents)) / 100).toFixed(2);
}

/**
 * 构造待签名串：剔除空值，按 key 升序，`k=v` 用 & 连接（不 URL 编码）。导出供单测。
 *
 * P3-1：**两个方向规则不同，不能共用一份剔除表**。
 *  - 请求方向（createCharge）：只剔 `sign`，`sign_type` 参与签名。我们确实把 sign_type=RSA2
 *    提交给了网关，签名串里却把它剔掉 → 网关必回 isv.invalid-signature，整条轨零成交。
 *  - 通知方向（rsaCheckV1）：`sign` 与 `sign_type` 都剔除。
 */
export function buildSignString(
  params: Record<string, string>,
  opts?: { forRequest?: boolean }
): string {
  const dropped = opts?.forRequest ? ['sign'] : ['sign', 'sign_type'];
  return Object.keys(params)
    .filter((k) => !dropped.includes(k) && params[k] !== '' && params[k] != null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

/** 用支付宝公钥验签异步通知（剔除 sign/sign_type，排序验 RSA-SHA256）。导出供单测。 */
export function verifyAlipaySign(
  params: Record<string, string>,
  sign: string,
  alipayPublicKeyPem: string
): boolean {
  try {
    const signStr = buildSignString(params);
    return crypto
      .createVerify('RSA-SHA256')
      .update(signStr, 'utf8')
      .verify(alipayPublicKeyPem, sign, 'base64');
  } catch {
    return false;
  }
}

/** 把裸 base64 密钥补上 PEM 头尾并按 64 字符折行；已是 PEM 则原样返回。 */
function wrapPem(key: string, label: 'PRIVATE KEY' | 'PUBLIC KEY'): string {
  const trimmed = (key || '').trim();
  if (!trimmed) return '';
  if (trimmed.includes('BEGIN')) return trimmed;
  const body = trimmed.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? trimmed;
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

function appendQuery(url: string, key: string, value: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${key}=${encodeURIComponent(value)}`;
}

/** 支付宝时间戳格式 `yyyy-MM-dd HH:mm:ss`（东八区）。 */
function formatAlipayTimestamp(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ` +
    `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`
  );
}
