import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { SandboxProvider } from '@/lib/payment/providers/sandbox';
import { verifyStripeSignature } from '@/lib/payment/providers/stripe';
import { AlipayProvider, buildSignString } from '@/lib/payment/providers/alipay';
import { decryptWechatResource } from '@/lib/payment/providers/wechat';
import type { RechargeSettings } from '@/lib/payment/settings';

describe('SandboxProvider', () => {
  const provider = new SandboxProvider();

  it('▶ createCharge：payUrl 指向沙箱确认页并带 out_trade_no', async () => {
    const res = await provider.createCharge({
      outTradeNo: 'LL123',
      amountCents: 1000,
      subject: '充值',
      returnUrl: 'https://app.test/home',
      notifyUrl: 'https://app.test/api/wallet/callback/sandbox',
    });
    expect(res.payUrl).toBe('https://app.test/api/wallet/sandbox/pay?out_trade_no=LL123');
  });

  it('▶ verifyCallback：action=pay → paid:true；action=cancel → paid:false', async () => {
    const pay = await provider.verifyCallback(
      new Request('https://app.test/api/wallet/callback/sandbox?out_trade_no=LL1&action=pay'),
      ''
    );
    expect(pay).toEqual({
      outTradeNo: 'LL1',
      paid: true,
      providerRef: 'sandbox_LL1',
      rawStatus: 'pay',
    });

    const cancel = await provider.verifyCallback(
      new Request('https://app.test/cb?out_trade_no=LL1&action=cancel'),
      ''
    );
    expect(cancel?.paid).toBe(false);
  });

  it('▶ verifyCallback：无 out_trade_no → null', async () => {
    const res = await provider.verifyCallback(new Request('https://app.test/cb'), '');
    expect(res).toBeNull();
  });
});

describe('Stripe webhook 验签', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ type: 'checkout.session.completed' });

  it('▶ 合法签名 → true', () => {
    const t = '1700000000';
    const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret)).toBe(true);
  });

  it('▶ 篡改签名 → false', () => {
    expect(verifyStripeSignature(body, 't=1700000000,v1=deadbeef', secret)).toBe(false);
  });

  it('▶ 篡改报文体 → false', () => {
    const t = '1700000000';
    const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    expect(verifyStripeSignature(body + 'x', `t=${t},v1=${sig}`, secret)).toBe(false);
  });

  it('▶ 缺 t/v1 → false', () => {
    expect(verifyStripeSignature(body, 'v1=abc', secret)).toBe(false);
  });
});

describe('支付宝待签名串构造', () => {
  it('▶ 剔除 sign/sign_type/空值，按 key 升序，k=v& 连接', () => {
    const s = buildSignString({
      b: '2',
      a: '1',
      sign: 'xxx',
      sign_type: 'RSA2',
      empty: '',
      charset: 'utf-8',
    });
    expect(s).toBe('a=1&b=2&charset=utf-8');
  });
});

describe('支付宝回调业务字段校验（M2）+ 金额对账', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const provider = new AlipayProvider({
    alipayAppId: 'app-123',
    alipayPrivateKey: '',
    alipayPublicKey: pubPem,
    alipayGateway: '',
  } as unknown as RechargeSettings);

  // 用测试私钥对 buildSignString(params) 签名，模拟支付宝异步通知。
  function signedBody(params: Record<string, string>): string {
    const sign = crypto
      .createSign('RSA-SHA256')
      .update(buildSignString(params), 'utf8')
      .sign(privateKey, 'base64');
    return new URLSearchParams({ ...params, sign }).toString();
  }

  it('▶ app_id 匹配 + 合法签名 → paid，且回报金额转分（12.34 元→1234 分）', async () => {
    const body = signedBody({
      app_id: 'app-123',
      out_trade_no: 'LLA',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '12.34',
    });
    const res = await provider.verifyCallback(new Request('https://app.test/cb'), body);
    expect(res?.paid).toBe(true);
    expect(res?.outTradeNo).toBe('LLA');
    expect(res?.amountCents).toBe(1234);
  });

  it('▶ app_id 不匹配（他人应用即便签名合法）→ null（M2 防冒充到账）', async () => {
    const body = signedBody({
      app_id: 'attacker-app',
      out_trade_no: 'LLA',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '12.34',
    });
    const res = await provider.verifyCallback(new Request('https://app.test/cb'), body);
    expect(res).toBeNull();
  });

  it('▶ 签名非法 → null（验签仍是第一道闸）', async () => {
    const body = new URLSearchParams({
      app_id: 'app-123',
      out_trade_no: 'LLA',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '12.34',
      sign: 'deadbeef',
    }).toString();
    const res = await provider.verifyCallback(new Request('https://app.test/cb'), body);
    expect(res).toBeNull();
  });
});

describe('微信 v3 resource 解密（AES-256-GCM 往返）', () => {
  it('▶ 正确密钥 → 还原明文', () => {
    const key = '01234567890123456789012345678901'; // 32 字节
    const nonce = 'abcdefghijkl'; // 12 字节
    const aad = 'transaction';
    const plaintext = JSON.stringify({ out_trade_no: 'LL9', trade_state: 'SUCCESS' });

    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
    cipher.setAAD(Buffer.from(aad));
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ciphertext = Buffer.concat([enc, tag]).toString('base64');

    expect(
      decryptWechatResource({ ciphertext, nonce, associated_data: aad }, key)
    ).toBe(plaintext);
  });

  it('▶ 错误密钥 → null（GCM 校验失败）', () => {
    const key = '01234567890123456789012345678901';
    const nonce = 'abcdefghijkl';
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
    const enc = Buffer.concat([cipher.update('secret', 'utf8'), cipher.final()]);
    const ciphertext = Buffer.concat([enc, cipher.getAuthTag()]).toString('base64');
    const wrongKey = 'ffffffffffffffffffffffffffffffff';
    expect(decryptWechatResource({ ciphertext, nonce }, wrongKey)).toBeNull();
  });

  it('▶ 非 32 字节密钥 → null', () => {
    expect(decryptWechatResource({ ciphertext: 'AAAA', nonce: 'abcdefghijkl' }, 'short')).toBeNull();
  });
});
