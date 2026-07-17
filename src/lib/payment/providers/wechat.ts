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
  private readonly appId: string;
  private readonly mchId: string;
  private readonly apiV3Key: string;
  private readonly serialNo: string;
  private readonly privateKeyPem: string;
  private readonly platformCertPem: string;

  constructor(s: RechargeSettings) {
    this.appId = s.wechatAppId;
    this.mchId = s.wechatMchId;
    this.apiV3Key = s.wechatApiV3Key;
    this.serialNo = s.wechatSerialNo;
    this.privateKeyPem = s.wechatPrivateKey.trim();
    this.platformCertPem = s.wechatPlatformCert.trim();
  }

  async createCharge(params: CreateChargeParams): Promise<CreateChargeResult> {
    const urlPath = '/v3/pay/transactions/native';
    const body = JSON.stringify({
      appid: this.appId,
      mchid: this.mchId,
      description: params.subject,
      out_trade_no: params.outTradeNo,
      notify_url: params.notifyUrl,
      amount: { total: Math.max(0, Math.round(params.amountCents)), currency: 'CNY' },
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

    // 1) 验签：message = `${timestamp}\n${nonce}\n${rawBody}\n`，用平台证书公钥验 RSA-SHA256。
    if (
      !verifyWechatSignature(
        `${timestamp}\n${nonce}\n${rawBody}\n`,
        signature,
        this.platformCertPem
      )
    ) {
      return null;
    }

    // 2) 解密 resource（AES-256-GCM，APIv3 密钥）。
    let notify: { resource?: WechatResource };
    try {
      notify = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const resource = notify.resource;
    if (!resource) return null;
    const decrypted = decryptWechatResource(resource, this.apiV3Key);
    if (!decrypted) return null;

    let payload: { out_trade_no?: string; trade_state?: string; transaction_id?: string };
    try {
      payload = JSON.parse(decrypted);
    } catch {
      return null;
    }
    const outTradeNo = payload.out_trade_no || '';
    if (!outTradeNo) return null;
    return {
      outTradeNo,
      paid: payload.trade_state === 'SUCCESS',
      providerRef: payload.transaction_id,
      rawStatus: payload.trade_state,
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

interface WechatResource {
  ciphertext: string;
  nonce: string;
  associated_data?: string;
  algorithm?: string;
}

/** 用微信支付平台证书公钥验签。导出供单测。 */
export function verifyWechatSignature(
  message: string,
  signatureBase64: string,
  platformCertPem: string
): boolean {
  try {
    const publicKey = new crypto.X509Certificate(platformCertPem).publicKey;
    return crypto
      .createVerify('RSA-SHA256')
      .update(message, 'utf8')
      .verify(publicKey, signatureBase64, 'base64');
  } catch {
    return false;
  }
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
