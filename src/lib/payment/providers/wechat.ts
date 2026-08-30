import crypto from 'crypto';
import type {
  PaymentProvider,
  CreateChargeParams,
  CreateChargeResult,
  CallbackResult,
  CallbackAck,
} from '@/lib/payment/types';
import type { RechargeSettings } from '@/lib/payment/settings';

const WECHAT_API_BASE = 'https://api.mch.weixin.qq.com';
/** 微信境内收单固定人民币。 */
const WECHAT_CURRENCY = 'CNY';
const WECHAT_HARMLESS_EVENT_TYPES = new Set([
  'MCHTRANSFER.SUCCESS',
  'MCHTRANSFER.FAIL',
]);
const WECHAT_HARMLESS_TRANSACTION_STATES = new Set([
  'CLOSED',
  'REVOKED',
  'PAYERROR',
]);
const WECHAT_HARMLESS_REFUND_EVENTS = new Set([
  'REFUND.CLOSED',
  'REFUND.ABNORMAL',
]);

/**
 * 微信支付渠道（Native 扫码，API v3）。
 *  - createCharge：POST /v3/pay/transactions/native，`Authorization: WECHATPAY2-SHA256-RSA2048 ...`
 *    （商户私钥对 `方法\nURL\n时间戳\n随机串\n报文体\n` 签名）；返回 code_url 作为二维码内容；
 *  - verifyCallback：用微信支付平台证书验签（Wechatpay-Signature 头），再用 APIv3 密钥 AES-256-GCM
 *    解密 resource → trade_state='SUCCESS' → out_trade_no。
 *
 * 金额单位：微信 amount.total 以「分」为单位，与我们存储的 amountCents 同口径。
 * 需你配置：商户号、AppID、APIv3 密钥、商户证书序列号 + 商户 API 私钥、微信支付平台证书。
 */
export class WechatProvider implements PaymentProvider {
  readonly name = 'wechat' as const;
  readonly mode = 'live' as const;
  readonly account: string;
  private readonly appId: string;
  private readonly mchId: string;
  private readonly apiV3Key: string;
  private readonly serialNo: string;
  private readonly privateKeyPem: string;
  private readonly platformCertPem: string;

  constructor(s: RechargeSettings) {
    this.appId = s.wechatAppId;
    this.mchId = s.wechatMchId;
    this.account = this.mchId.trim() || 'default';
    this.apiV3Key = s.wechatApiV3Key;
    this.serialNo = s.wechatSerialNo;
    this.privateKeyPem = s.wechatPrivateKey.trim();
    this.platformCertPem = s.wechatPlatformCert.trim();
  }

  async createCharge(params: CreateChargeParams): Promise<CreateChargeResult> {
    // 微信境内收单只做人民币；币种不符必须当场炸，绝不静默按 CNY 收（P3-15）。
    if (params.currency !== WECHAT_CURRENCY) {
      throw new Error(`Wechat only settles ${WECHAT_CURRENCY}, got ${params.currency}`);
    }
    const urlPath = '/v3/pay/transactions/native';
    const body = JSON.stringify({
      appid: this.appId,
      mchid: this.mchId,
      description: params.subject,
      out_trade_no: params.outTradeNo,
      notify_url: params.notifyUrl,
      // 与我方 expiresAt 同一时刻关单（Native 默认 2 小时）。网关不设截止时间的话，
      // 超时支付照收，而 creditPaidOrder 会判 late_paid、不发放任何权益。
      time_expire: formatWechatTimestamp(params.expiresAt),
      amount: {
        total: Math.max(0, Math.round(params.amountCents)),
        currency: WECHAT_CURRENCY,
      },
    });
    const authorization = this.buildAuthHeader('POST', urlPath, body);
    const res = await fetch(`${WECHAT_API_BASE}${urlPath}`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    });
    const data = (await res.json()) as { code_url?: string; message?: string; code?: string };
    if (!res.ok || !data.code_url) {
      throw new Error(`Wechat createCharge failed: ${data.code ?? res.status} ${data.message ?? ''}`);
    }
    return { qrCode: data.code_url, providerRef: params.outTradeNo };
  }

  async verifyCallback(req: Request, rawBody: string): Promise<CallbackResult | null> {
    const timestamp = req.headers.get('wechatpay-timestamp');
    const nonce = req.headers.get('wechatpay-nonce');
    const signature = req.headers.get('wechatpay-signature');
    if (!timestamp || !nonce || !signature || !this.platformCertPem) return null;

    // 时间戳容差（防重放）：拒绝签名时间超过 5 分钟的通知（微信推荐；到账 CAS 另有幂等兜底）。
    // P6-14：非数字**直接拒**。旧写法 `if (isFinite(t) && …)` 在 t 非数字时跳过整条校验（极性写反）。
    const tSec = Number(timestamp);
    if (!Number.isFinite(tSec) || Math.abs(Date.now() / 1000 - tSec) > 300) {
      return null;
    }

    // 1) 验签：message = `${timestamp}\n${nonce}\n${rawBody}\n`，用平台证书公钥验 RSA-SHA256。
    //    L18：证书轮换期微信会用新证书签名（Wechatpay-Serial 指明是哪一张），所以配置项允许
    //    粘贴多张证书，这里按序列号挑；挑不中就逐张试，别让真实回调在轮换窗口里被拒。
    if (
      !verifyWechatSignature(
        `${timestamp}\n${nonce}\n${rawBody}\n`,
        signature,
        this.platformCertPem,
        req.headers.get('wechatpay-serial')
      )
    ) {
      return null;
    }

    let notify: {
      id?: string;
      create_time?: string;
      resource?: WechatResource;
      event_type?: string;
    };
    try {
      notify = JSON.parse(rawBody);
    } catch {
      return null;
    }

    // 2) 事件分流（P6-13）。旧实现不看事件类型：退款/合单等非交易通知一律 paid=false
    //    → ACK 500 → 微信按 15 次/24h 重推，永远推不成功。验签已过 = 确认来自微信，
    //    对我们不处理的事件回成功 ACK 才是正确应答。
    const eventType = notify.event_type ?? '';
    const isRefundEvent = eventType.startsWith('REFUND.');
    if (eventType && !eventType.startsWith('TRANSACTION.') && !isRefundEvent) {
      return {
        outTradeNo: '',
        paid: false,
        ...(WECHAT_HARMLESS_EVENT_TYPES.has(eventType)
          ? { acknowledged: true }
          : {}),
        rawStatus: eventType,
        eventId: notify.id,
        eventType,
        providerMode: this.mode,
        providerAccount: this.account,
        occurredAt: parseWechatDate(notify.create_time),
      };
    }

    // 3) 解密 resource（AES-256-GCM，APIv3 密钥）。
    const resource = notify.resource;
    if (!resource) return null;
    const decrypted = decryptWechatResource(resource, this.apiV3Key);
    if (!decrypted) return null;

    let payload: {
      out_trade_no?: string;
      trade_state?: string;
      refund_status?: string;
      transaction_id?: string;
      refund_id?: string;
      success_time?: string;
      amount?: { total?: number; payer_total?: number; currency?: string };
    };
    try {
      payload = JSON.parse(decrypted);
    } catch {
      return null;
    }
    const outTradeNo = payload.out_trade_no || '';
    if (!outTradeNo) return null;
    // 微信 amount.total 以「分」为单位，与订单 amountCents 同口径，供上层对账。
    const amountCents =
      typeof payload.amount?.total === 'number' ? payload.amount.total : undefined;
    const currency = (payload.amount?.currency || WECHAT_CURRENCY).toUpperCase();

    if (isRefundEvent) {
      // 退款成功 → 反向流程；REFUND.ABNORMAL / REFUND.CLOSED 表示退款并未完成，
      // 只回 ACK 不冻结权益（据此冻结会误伤没退成的订单）。
      const refunded =
        eventType === 'REFUND.SUCCESS' || payload.refund_status === 'SUCCESS';
      return {
        outTradeNo,
        paid: false,
        ...(refunded
          ? { reversal: true }
          : WECHAT_HARMLESS_REFUND_EVENTS.has(eventType)
            ? { acknowledged: true }
            : {}),
        currency,
        providerRef: payload.refund_id ?? payload.transaction_id,
        rawStatus: eventType || payload.refund_status,
        eventId: notify.id,
        eventType: eventType || 'REFUND',
        providerMode: this.mode,
        providerAccount: this.account,
        occurredAt: parseWechatDate(payload.success_time || notify.create_time),
        objectRefs: [
          ...(payload.refund_id
            ? [{ objectType: 'refund', objectId: payload.refund_id }]
            : []),
          ...(payload.transaction_id
            ? [{ objectType: 'transaction', objectId: payload.transaction_id }]
            : []),
        ],
      };
    }

    const paid = payload.trade_state === 'SUCCESS';
    return {
      outTradeNo,
      paid,
      ...(!paid && payload.trade_state &&
      WECHAT_HARMLESS_TRANSACTION_STATES.has(payload.trade_state)
        ? { acknowledged: true }
        : {}),
      amountCents,
      currency,
      providerRef: payload.transaction_id,
      rawStatus: payload.trade_state,
      eventId: notify.id,
      eventType: eventType || 'TRANSACTION',
      providerMode: this.mode,
      providerAccount: this.account,
      occurredAt: parseWechatDate(payload.success_time || notify.create_time),
      objectRefs: payload.transaction_id
        ? [{ objectType: 'transaction', objectId: payload.transaction_id }]
        : undefined,
    };
  }

  callbackAck(ok: boolean): CallbackAck {
    // 微信 v3 要求回 JSON；成功回 200 + {code:SUCCESS}，失败回非 200 + {code:FAIL} 触发重试。
    return ok
      ? { body: JSON.stringify({ code: 'SUCCESS' }), contentType: 'application/json', status: 200 }
      : { body: JSON.stringify({ code: 'FAIL', message: 'failed' }), contentType: 'application/json', status: 500 };
  }

  /** 构造 v3 Authorization 头（商户私钥对规范化串签名）。 */
  private buildAuthHeader(method: string, urlPath: string, body: string): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(message, 'utf8')
      .sign(this.privateKeyPem, 'base64');
    return (
      `WECHATPAY2-SHA256-RSA2048 mchid="${this.mchId}",` +
      `nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.serialNo}",` +
      `signature="${signature}"`
    );
  }
}

/**
 * 微信支付 v3 的 time_expire 要求 RFC3339，形如 `2026-08-22T19:30:00+08:00`。
 * 统一按东八区表示（与 formatAlipayTimestamp 同口径），时刻本身仍是绝对时间。
 */
function formatWechatTimestamp(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-` +
    `${p(shifted.getUTCDate())}T${p(shifted.getUTCHours())}:` +
    `${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}+08:00`
  );
}

function parseWechatDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

interface WechatResource {
  ciphertext: string;
  nonce: string;
  associated_data?: string;
  algorithm?: string;
}

/**
 * 用微信支付平台证书公钥验签。导出供单测。
 *
 * L18：`platformCertPem` 允许**依次粘贴多张证书**（轮换期新旧并存）。给了 `serial`
 * 就优先用序列号匹配的那张，匹配不到再逐张试——只能存一份证书时，轮换窗口里
 * 微信用新证书签的**真实**回调会被全部拒掉。
 */
export function verifyWechatSignature(
  message: string,
  signatureBase64: string,
  platformCertPem: string,
  serial?: string | null
): boolean {
  const certs = splitPemCertificates(platformCertPem);
  if (certs.length === 0) return false;

  const parsed: Array<{ cert: crypto.X509Certificate; serial: string }> = [];
  for (const pem of certs) {
    try {
      const cert = new crypto.X509Certificate(pem);
      parsed.push({ cert, serial: normalizeSerial(cert.serialNumber) });
    } catch {
      // 单张解析失败不该拖垮其余证书。
    }
  }

  const wanted = serial ? normalizeSerial(serial) : '';
  const ordered = wanted
    ? [...parsed].sort((a, b) => Number(b.serial === wanted) - Number(a.serial === wanted))
    : parsed;

  for (const { cert } of ordered) {
    try {
      const ok = crypto
        .createVerify('RSA-SHA256')
        .update(message, 'utf8')
        .verify(cert.publicKey, signatureBase64, 'base64');
      if (ok) return true;
    } catch {
      // 换下一张。
    }
  }
  return false;
}

/** 把一段可能含多张证书的 PEM 文本拆成单张。 */
function splitPemCertificates(pem: string): string[] {
  const matches = (pem || '').match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
  );
  if (matches && matches.length > 0) return matches;
  const trimmed = (pem || '').trim();
  return trimmed ? [trimmed] : [];
}

/** 序列号归一：去前导 0、统一大写（Node 与微信侧的十六进制写法不完全一致）。 */
function normalizeSerial(v: string): string {
  return v.replace(/^0+/, '').toUpperCase();
}

/** AES-256-GCM 解密回调 resource（APIv3 密钥为 32 字节）。返回明文 JSON 串或 null。导出供单测。 */
export function decryptWechatResource(
  resource: WechatResource,
  apiV3Key: string
): string | null {
  try {
    const key = Buffer.from(apiV3Key, 'utf8');
    if (key.length !== 32) return null;
    const data = Buffer.from(resource.ciphertext, 'base64');
    // 密文尾部 16 字节为 GCM auth tag。
    const authTag = data.subarray(data.length - 16);
    const enc = data.subarray(0, data.length - 16);
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(resource.nonce, 'utf8')
    );
    decipher.setAuthTag(authTag);
    if (resource.associated_data) {
      decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
    }
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
