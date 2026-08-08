import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { SandboxProvider } from '@/lib/payment/providers/sandbox';
import { StripeProvider, verifyStripeSignature } from '@/lib/payment/providers/stripe';
import { AlipayProvider, buildSignString } from '@/lib/payment/providers/alipay';
import { WechatProvider, decryptWechatResource } from '@/lib/payment/providers/wechat';
import type { RechargeSettings } from '@/lib/payment/settings';
import {
  WECHAT_CERT_A,
  WECHAT_KEY_A,
  WECHAT_CERT_B,
  WECHAT_KEY_B,
  WECHAT_SERIAL_B,
} from './wechatCertFixture';

const settings = (o: Partial<RechargeSettings>) => o as unknown as RechargeSettings;

describe('SandboxProvider', () => {
  const provider = new SandboxProvider();

  it('▶ createCharge：payUrl 指向沙箱确认页并带 out_trade_no', async () => {
    const res = await provider.createCharge({
      outTradeNo: 'LL123',
      amountCents: 1000,
      subject: '充值',
      currency: 'CNY',
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

/* ------------------------------------------------------------------ */
/*  支付宝                                                              */
/* ------------------------------------------------------------------ */

const alipayKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ALIPAY_PUB = alipayKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const ALIPAY_PRIV = alipayKeys.privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();

function alipayProvider(o: Partial<RechargeSettings> = {}) {
  return new AlipayProvider(
    settings({
      alipayAppId: 'app-123',
      alipayPrivateKey: ALIPAY_PRIV,
      alipayPublicKey: ALIPAY_PUB,
      alipaySellerId: '',
      alipayGateway: 'https://openapi.alipaydev.com/gateway.do',
      ...o,
    })
  );
}

/**
 * 用**调用方手写的常量待签名串**签一条通知报文。
 * 绝不用应用自己的 buildSignString 造夹具——用它签、再用它验只能证明自洽，
 * 规则整体写错时测试照样全绿（这正是本轮之前那版单测踩的坑）。
 */
function signedNotify(params: Record<string, string>, handWrittenSignString: string): string {
  const sign = crypto
    .createSign('RSA-SHA256')
    .update(handWrittenSignString, 'utf8')
    .sign(alipayKeys.privateKey, 'base64');
  return new URLSearchParams({ ...params, sign }).toString();
}

describe('支付宝待签名串：请求方向与通知方向规则不同（P3-1）', () => {
  const params = {
    b: '2',
    a: '1',
    sign: 'xxx',
    sign_type: 'RSA2',
    empty: '',
    charset: 'utf-8',
  };

  it('▶ 通知方向（rsaCheckV1）：剔除 sign 与 sign_type', () => {
    expect(buildSignString(params)).toBe('a=1&b=2&charset=utf-8');
  });

  it('▶ 请求方向：只剔除 sign，sign_type 必须参与签名', () => {
    expect(buildSignString(params, { forRequest: true })).toBe(
      'a=1&b=2&charset=utf-8&sign_type=RSA2'
    );
  });

  it('▶ createCharge 发出的签名可被「含 sign_type 的独立待签串」验过', async () => {
    const res = await alipayProvider().createCharge({
      outTradeNo: 'LLREQ1',
      amountCents: 1234,
      subject: '充值 12.34 元',
      currency: 'CNY',
      returnUrl: 'https://app.test/home',
      notifyUrl: 'https://app.test/api/wallet/callback/alipay',
    });
    const query = new URL(res.payUrl!).searchParams;
    const sign = query.get('sign')!;
    expect(query.get('sign_type')).toBe('RSA2'); // 确实提交了 sign_type

    // 独立重算待签名串（本地实现，不调应用代码）：剔 sign 与空值、按 key 升序、k=v 用 & 连。
    const entries: Array<[string, string]> = [];
    for (const [k, v] of query) {
      if (k !== 'sign' && v !== '') entries.push([k, v]);
    }
    entries.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    const expectedSignString = entries.map(([k, v]) => `${k}=${v}`).join('&');

    expect(
      crypto
        .createVerify('RSA-SHA256')
        .update(expectedSignString, 'utf8')
        .verify(ALIPAY_PUB, sign, 'base64')
    ).toBe(true);
  });

  it('▶ createCharge：币种非 CNY 直接抛错，不静默按人民币收（P3-15）', async () => {
    await expect(
      alipayProvider().createCharge({
        outTradeNo: 'LLREQ2',
        amountCents: 1234,
        subject: 'x',
        currency: 'USD',
        returnUrl: 'https://app.test/home',
        notifyUrl: 'https://app.test/api/wallet/callback/alipay',
      })
    ).rejects.toThrow(/CNY/);
  });
});

describe('支付宝异步通知：业务字段校验 + 退款判定', () => {
  it('▶ 合法签名 + app_id 匹配 → paid，金额转分、币种回报 CNY', async () => {
    const body = signedNotify(
      {
        app_id: 'app-123',
        out_trade_no: 'LLA',
        total_amount: '12.34',
        trade_status: 'TRADE_SUCCESS',
        sign_type: 'RSA2',
      },
      'app_id=app-123&out_trade_no=LLA&total_amount=12.34&trade_status=TRADE_SUCCESS'
    );
    const res = await alipayProvider().verifyCallback(new Request('https://app.test/cb'), body);
    expect(res?.paid).toBe(true);
    expect(res?.outTradeNo).toBe('LLA');
    expect(res?.amountCents).toBe(1234);
    expect(res?.currency).toBe('CNY');
  });

  it('▶ TRADE_FINISHED 仍是已付（钱已收且不可再退，绝不能连它一起删）', async () => {
    const body = signedNotify(
      {
        app_id: 'app-123',
        out_trade_no: 'LLB',
        total_amount: '1.00',
        trade_status: 'TRADE_FINISHED',
        sign_type: 'RSA2',
      },
      'app_id=app-123&out_trade_no=LLB&total_amount=1.00&trade_status=TRADE_FINISHED'
    );
    const res = await alipayProvider().verifyCallback(new Request('https://app.test/cb'), body);
    expect(res?.paid).toBe(true);
  });

  it('▶ 部分退款通知（trade_status 仍是 TRADE_SUCCESS）→ paid=false 且标记 reversal（P3-2）', async () => {
    const body = signedNotify(
      {
        app_id: 'app-123',
        out_trade_no: 'LLA',
        total_amount: '12.34',
        trade_status: 'TRADE_SUCCESS',
        refund_fee: '5.00',
        gmt_refund: '2026-08-01 10:00:00',
        out_biz_no: 'RF-1',
        sign_type: 'RSA2',
      },
      'app_id=app-123&gmt_refund=2026-08-01 10:00:00&out_biz_no=RF-1&out_trade_no=LLA' +
        '&refund_fee=5.00&total_amount=12.34&trade_status=TRADE_SUCCESS'
    );
    const res = await alipayProvider().verifyCallback(new Request('https://app.test/cb'), body);
    expect(res?.paid).toBe(false);
    expect(res?.reversal).toBe(true);
  });

  it('▶ 缺 app_id 时校验不得被整条跳过（L17）', async () => {
    const body = signedNotify(
      {
        out_trade_no: 'LLA',
        total_amount: '12.34',
        trade_status: 'TRADE_SUCCESS',
        sign_type: 'RSA2',
      },
      'out_trade_no=LLA&total_amount=12.34&trade_status=TRADE_SUCCESS'
    );
    const res = await alipayProvider().verifyCallback(new Request('https://app.test/cb'), body);
    expect(res).toBeNull();
  });

  it('▶ seller_id 已配置：不匹配 → null，匹配 → paid（L17）', async () => {
    const provider = alipayProvider({ alipaySellerId: '2088ABC' });

    const bad = signedNotify(
      {
        app_id: 'app-123',
        out_trade_no: 'LLA',
        seller_id: '2088XYZ',
        total_amount: '12.34',
        trade_status: 'TRADE_SUCCESS',
        sign_type: 'RSA2',
      },
      'app_id=app-123&out_trade_no=LLA&seller_id=2088XYZ&total_amount=12.34&trade_status=TRADE_SUCCESS'
    );
    expect(await provider.verifyCallback(new Request('https://app.test/cb'), bad)).toBeNull();

    const good = signedNotify(
      {
        app_id: 'app-123',
        out_trade_no: 'LLA',
        seller_id: '2088ABC',
        total_amount: '12.34',
        trade_status: 'TRADE_SUCCESS',
        sign_type: 'RSA2',
      },
      'app_id=app-123&out_trade_no=LLA&seller_id=2088ABC&total_amount=12.34&trade_status=TRADE_SUCCESS'
    );
    expect(
      (await provider.verifyCallback(new Request('https://app.test/cb'), good))?.paid
    ).toBe(true);
  });

  it('▶ app_id 不匹配（他人应用即便签名合法）→ null（M2 防冒充到账）', async () => {
    const body = signedNotify(
      {
        app_id: 'attacker-app',
        out_trade_no: 'LLA',
        total_amount: '12.34',
        trade_status: 'TRADE_SUCCESS',
        sign_type: 'RSA2',
      },
      'app_id=attacker-app&out_trade_no=LLA&total_amount=12.34&trade_status=TRADE_SUCCESS'
    );
    const res = await alipayProvider().verifyCallback(new Request('https://app.test/cb'), body);
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
    const res = await alipayProvider().verifyCallback(new Request('https://app.test/cb'), body);
    expect(res).toBeNull();
  });

  it('▶ 支付宝 ACK 恒 200（其协议判据是响应体不是状态码，别跟 Stripe 一起改）', () => {
    expect(alipayProvider().callbackAck(false)).toEqual({
      body: 'fail',
      contentType: 'text/plain',
      status: 200,
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Stripe                                                             */
/* ------------------------------------------------------------------ */

const STRIPE_HOOK_SECRET = 'whsec_test_secret';

function stripeProvider(o: Partial<RechargeSettings> = {}) {
  return new StripeProvider(
    settings({
      stripeSecretKey: 'sk_test_abc',
      stripeWebhookSecret: STRIPE_HOOK_SECRET,
      ...o,
    })
  );
}

/** 手写 Stripe 规则：signedPayload = `${t}.${rawBody}`，v1 = HMAC-SHA256(secret, signedPayload)。 */
function stripeSigHeader(t: string, rawBody: string, secret = STRIPE_HOOK_SECRET): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

function stripeReq(rawBody: string, t = String(Math.floor(Date.now() / 1000))): Request {
  return new Request('https://app.test/cb', {
    method: 'POST',
    headers: { 'stripe-signature': stripeSigHeader(t, rawBody) },
    body: rawBody,
  });
}

describe('Stripe webhook 验签', () => {
  const body = JSON.stringify({ type: 'checkout.session.completed' });

  it('▶ 合法签名 → true', () => {
    expect(verifyStripeSignature(body, stripeSigHeader('1700000000', body), STRIPE_HOOK_SECRET)).toBe(true);
  });

  it('▶ 篡改签名 → false', () => {
    expect(verifyStripeSignature(body, 't=1700000000,v1=deadbeef', STRIPE_HOOK_SECRET)).toBe(false);
  });

  it('▶ 篡改报文体 → false', () => {
    expect(
      verifyStripeSignature(body + 'x', stripeSigHeader('1700000000', body), STRIPE_HOOK_SECRET)
    ).toBe(false);
  });

  it('▶ 缺 t/v1 → false', () => {
    expect(verifyStripeSignature(body, 'v1=abc', STRIPE_HOOK_SECRET)).toBe(false);
  });

  it('▶ 轮换期多个 v1：命中任一即通过（L19，方向是别拒真）', () => {
    const t = '1700000000';
    const good = crypto
      .createHmac('sha256', STRIPE_HOOK_SECRET)
      .update(`${t}.${body}`)
      .digest('hex');
    const stale = 'f'.repeat(good.length);
    expect(verifyStripeSignature(body, `t=${t},v1=${stale},v1=${good}`, STRIPE_HOOK_SECRET)).toBe(true);
  });
});

describe('Stripe verifyCallback', () => {
  const session = (o: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'checkout.session.completed',
      livemode: false,
      data: {
        object: {
          client_reference_id: 'LLS1',
          payment_status: 'paid',
          amount_total: 3900,
          currency: 'usd',
          ...o,
        },
      },
    });

  it('▶ 回报网关币种（大写 ISO-4217）供上层比二元组（P3-15）', async () => {
    const body = session();
    const res = await stripeProvider().verifyCallback(stripeReq(body), body);
    expect(res?.paid).toBe(true);
    expect(res?.currency).toBe('USD');
    expect(res?.amountCents).toBe(3900);
  });

  it('▶ ACK：成功 200 / 失败 500（P3-3，Stripe 看状态码判投递）', () => {
    const p = stripeProvider();
    expect(p.callbackAck(true).status).toBe(200);
    expect(p.callbackAck(false).status).toBe(500);
  });

  it('▶ live 密钥下拒绝 livemode!==true 的事件（P3-4）', async () => {
    const live = stripeProvider({ stripeSecretKey: 'sk_live_abc' });
    const testEvent = session();
    expect(await live.verifyCallback(stripeReq(testEvent), testEvent)).toBeNull();

    const liveEvent = JSON.stringify({
      type: 'checkout.session.completed',
      livemode: true,
      data: { object: { client_reference_id: 'LLS1', payment_status: 'paid', amount_total: 3900, currency: 'usd' } },
    });
    expect((await live.verifyCallback(stripeReq(liveEvent), liveEvent))?.paid).toBe(true);
  });

  it('▶ test 密钥不受 livemode 限制（本地/测试链路照常）', async () => {
    const body = session();
    expect((await stripeProvider().verifyCallback(stripeReq(body), body))?.paid).toBe(true);
  });

  it('▶ charge.refunded → reversal（P3-16），绝不到账', async () => {
    const body = JSON.stringify({
      type: 'charge.refunded',
      livemode: false,
      data: { object: { metadata: { out_trade_no: 'LLS1' }, currency: 'cny', amount_total: 3900 } },
    });
    const res = await stripeProvider().verifyCallback(stripeReq(body), body);
    expect(res?.paid).toBe(false);
    expect(res?.reversal).toBe(true);
    expect(res?.outTradeNo).toBe('LLS1');
  });

  it('▶ charge.dispute.created → reversal（拿不到订单号也不静默吞）', async () => {
    const body = JSON.stringify({
      type: 'charge.dispute.created',
      livemode: false,
      data: { object: { currency: 'usd' } },
    });
    const res = await stripeProvider().verifyCallback(stripeReq(body), body);
    expect(res?.reversal).toBe(true);
    expect(res?.outTradeNo).toBe('');
  });

  it('▶ 时间戳非数字 → 直接拒（P6-14 极性）', async () => {
    const body = session();
    // 签名对 `abc.${body}` 合法 —— 只有新鲜度校验能挡住它。
    const res = await stripeProvider().verifyCallback(stripeReq(body, 'abc'), body);
    expect(res).toBeNull();
  });

  it('▶ createCharge：币种非法直接抛错（P3-15）', async () => {
    await expect(
      stripeProvider().createCharge({
        outTradeNo: 'LLS9',
        amountCents: 100,
        subject: 'x',
        currency: '元',
        returnUrl: 'https://app.test/home',
        notifyUrl: 'https://app.test/api/wallet/callback/stripe',
      })
    ).rejects.toThrow(/currency/i);
  });
});

/* ------------------------------------------------------------------ */
/*  微信支付                                                            */
/* ------------------------------------------------------------------ */

const WECHAT_KEY32 = '01234567890123456789012345678901';

function encryptResource(plaintext: string, aad = 'transaction') {
  const nonce = 'abcdefghijkl';
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(WECHAT_KEY32),
    Buffer.from(nonce)
  );
  cipher.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: Buffer.concat([enc, cipher.getAuthTag()]).toString('base64'),
    nonce,
    associated_data: aad,
  };
}

function wechatProvider(platformCert = WECHAT_CERT_A) {
  return new WechatProvider(
    settings({
      wechatAppId: 'wx-app',
      wechatMchId: '160000',
      wechatApiV3Key: WECHAT_KEY32,
      wechatSerialNo: 'MCH-SERIAL',
      wechatPrivateKey: WECHAT_KEY_A,
      wechatPlatformCert: platformCert,
    })
  );
}

/** 手写微信 v3 规则：message = `${timestamp}\n${nonce}\n${body}\n`，平台私钥 RSA-SHA256 签名。 */
function wechatReq(
  rawBody: string,
  opts: { timestamp?: string; keyPem?: string; serial?: string } = {}
): Request {
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = 'nonce-1';
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${timestamp}\n${nonce}\n${rawBody}\n`, 'utf8')
    .sign(opts.keyPem ?? WECHAT_KEY_A, 'base64');
  const headers: Record<string, string> = {
    'wechatpay-timestamp': timestamp,
    'wechatpay-nonce': nonce,
    'wechatpay-signature': signature,
  };
  if (opts.serial) headers['wechatpay-serial'] = opts.serial;
  return new Request('https://app.test/cb', { method: 'POST', headers, body: rawBody });
}

describe('微信 v3 resource 解密（AES-256-GCM 往返）', () => {
  it('▶ 正确密钥 → 还原明文', () => {
    const plaintext = JSON.stringify({ out_trade_no: 'LL9', trade_state: 'SUCCESS' });
    const resource = encryptResource(plaintext);
    expect(decryptWechatResource(resource, WECHAT_KEY32)).toBe(plaintext);
  });

  it('▶ 错误密钥 → null（GCM 校验失败）', () => {
    const resource = encryptResource('secret');
    expect(decryptWechatResource(resource, 'f'.repeat(32))).toBeNull();
  });

  it('▶ 非 32 字节密钥 → null', () => {
    expect(
      decryptWechatResource({ ciphertext: 'AAAA', nonce: 'abcdefghijkl' }, 'short')
    ).toBeNull();
  });
});

describe('微信 verifyCallback', () => {
  const txBody = (payload: Record<string, unknown>, eventType = 'TRANSACTION.SUCCESS') =>
    JSON.stringify({
      event_type: eventType,
      resource_type: 'encrypt-resource',
      resource: encryptResource(JSON.stringify(payload)),
    });

  it('▶ 交易成功通知 → paid + 币种大写', async () => {
    const body = txBody({
      out_trade_no: 'LLW1',
      trade_state: 'SUCCESS',
      transaction_id: 'wx-1',
      amount: { total: 3900, currency: 'cny' },
    });
    const res = await wechatProvider().verifyCallback(wechatReq(body), body);
    expect(res?.paid).toBe(true);
    expect(res?.amountCents).toBe(3900);
    expect(res?.currency).toBe('CNY');
  });

  it('▶ 非交易类事件 → acknowledged（P6-13，止住 15 次/24h 重推）', async () => {
    const body = JSON.stringify({ event_type: 'MCHTRANSFER.SUCCESS', summary: '转账' });
    const res = await wechatProvider().verifyCallback(wechatReq(body), body);
    expect(res?.acknowledged).toBe(true);
    expect(res?.paid).toBe(false);
  });

  it('▶ REFUND.SUCCESS → reversal；REFUND.CLOSED（未退成）→ 只 ACK 不冻结', async () => {
    const ok = txBody(
      { out_trade_no: 'LLW1', refund_status: 'SUCCESS', refund_id: 'rf-1', amount: { total: 3900 } },
      'REFUND.SUCCESS'
    );
    const okRes = await wechatProvider().verifyCallback(wechatReq(ok), ok);
    expect(okRes?.reversal).toBe(true);
    expect(okRes?.paid).toBe(false);

    const closed = txBody(
      { out_trade_no: 'LLW1', refund_status: 'CLOSED', amount: { total: 3900 } },
      'REFUND.CLOSED'
    );
    const closedRes = await wechatProvider().verifyCallback(wechatReq(closed), closed);
    expect(closedRes?.reversal).toBeUndefined();
    expect(closedRes?.acknowledged).toBe(true);
  });

  it('▶ 时间戳非数字 → 直接拒（P6-14 极性）', async () => {
    const body = txBody({ out_trade_no: 'LLW1', trade_state: 'SUCCESS', amount: { total: 1 } });
    // 签名对 `abc\nnonce-1\nbody\n` 合法 —— 只有新鲜度校验能挡住它。
    const res = await wechatProvider().verifyCallback(
      wechatReq(body, { timestamp: 'abc' }),
      body
    );
    expect(res).toBeNull();
  });

  it('▶ 轮换期：配置里存两张证书，用新证书签的真实回调必须验得过（L18）', async () => {
    const body = txBody({ out_trade_no: 'LLW2', trade_state: 'SUCCESS', amount: { total: 100 } });
    const provider = wechatProvider(`${WECHAT_CERT_A}\n${WECHAT_CERT_B}`);
    const res = await provider.verifyCallback(
      wechatReq(body, { keyPem: WECHAT_KEY_B, serial: WECHAT_SERIAL_B }),
      body
    );
    expect(res?.paid).toBe(true);
  });

  it('▶ 签名不匹配任何一张证书 → null', async () => {
    const body = txBody({ out_trade_no: 'LLW3', trade_state: 'SUCCESS', amount: { total: 100 } });
    const res = await wechatProvider(WECHAT_CERT_A).verifyCallback(
      wechatReq(body, { keyPem: WECHAT_KEY_B }),
      body
    );
    expect(res).toBeNull();
  });

  it('▶ createCharge：币种非 CNY 直接抛错（P3-15）', async () => {
    await expect(
      wechatProvider().createCharge({
        outTradeNo: 'LLW9',
        amountCents: 100,
        subject: 'x',
        currency: 'USD',
        returnUrl: 'https://app.test/home',
        notifyUrl: 'https://app.test/api/wallet/callback/wechat',
      })
    ).rejects.toThrow(/CNY/);
  });

  it('▶ ACK：成功 200 / 失败 500', () => {
    const p = wechatProvider();
    expect(p.callbackAck(true).status).toBe(200);
    expect(p.callbackAck(false).status).toBe(500);
  });
});
