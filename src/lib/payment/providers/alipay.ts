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
export class AlipayProvider implements PaymentProvider {
  readonly name = 'alipay' as const;
  private readonly appId: string;
  private readonly privateKeyPem: string;
  private readonly alipayPublicKeyPem: string;
  private readonly gateway: string;

  constructor(s: RechargeSettings) {
    this.appId = s.alipayAppId;
    this.privateKeyPem = wrapPem(s.alipayPrivateKey, 'PRIVATE KEY');
    this.alipayPublicKeyPem = wrapPem(s.alipayPublicKey, 'PUBLIC KEY');
    this.gateway = s.alipayGateway || 'https://openapi.alipay.com/gateway.do';
  }

  async createCharge(params: CreateChargeParams): Promise<CreateChargeResult> {
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
    const signStr = buildSignString(common);
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

    const outTradeNo = params.out_trade_no || '';
    if (!outTradeNo) return null;
    const paid =
      params.trade_status === 'TRADE_SUCCESS' ||
      params.trade_status === 'TRADE_FINISHED';
    return {
      outTradeNo,
      paid,
      providerRef: params.trade_no,
      rawStatus: params.trade_status,
    };
  }

  callbackAck(ok: boolean): CallbackAck {
    // 支付宝要求异步通知处理成功后回纯文本 "success"，否则会重试。
    return { body: ok ? 'success' : 'fail', contentType: 'text/plain', status: 200 };
  }
}

/** 分 → 元（两位小数字符串）。 */
function centsToYuan(cents: number): string {
  return (Math.max(0, Math.round(cents)) / 100).toFixed(2);
}

/** 构造待签名串：剔除 sign / sign_type / 空值，按 key 升序，`k=v` 用 & 连接（不 URL 编码）。导出供单测。 */
export function buildSignString(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] != null)
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
