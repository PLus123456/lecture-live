import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

/**
 * 支付回调路由：未认证公开端点的门禁与分流。
 * 覆盖 P6-2（限流 / 报文上界 / 审计去重）、P3-11（停用渠道不打死在途回调）、
 * P3-16（退款走反向流程）、P6-13（非交易事件回成功 ACK 止重推）。
 */

const {
  getCallbackPaymentProviderMock,
  creditPaidOrderMock,
  handlePaymentReversalMock,
  logSystemEventMock,
  enforceRateLimitMock,
  resolveRequestClientIpMock,
} = vi.hoisted(() => ({
  getCallbackPaymentProviderMock: vi.fn(),
  creditPaidOrderMock: vi.fn(),
  handlePaymentReversalMock: vi.fn(),
  logSystemEventMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  resolveRequestClientIpMock: vi.fn(),
}));

vi.mock('@/lib/payment', () => ({
  getCallbackPaymentProvider: getCallbackPaymentProviderMock,
}));
vi.mock('@/lib/payment/refundHandling', () => ({
  handlePaymentReversal: handlePaymentReversalMock,
}));
vi.mock('@/lib/wallet', () => ({ creditPaidOrder: creditPaidOrderMock }));
vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: vi.fn().mockResolvedValue({ site_url: 'https://app.test' }),
}));
vi.mock('@/lib/auditLog', () => ({ logSystemEvent: logSystemEventMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/clientIp', () => ({ resolveRequestClientIp: resolveRequestClientIpMock }));

import { POST } from '@/app/api/wallet/callback/[provider]/route';

/** 各家 ACK：Stripe/微信看状态码（失败 500），支付宝看响应体（恒 200）。 */
const stripeLikeProvider = (result: unknown) => ({
  verifyCallback: vi.fn().mockResolvedValue(result),
  callbackAck: (ok: boolean) =>
    ok
      ? { body: 'success', contentType: 'text/plain', status: 200 }
      : { body: 'fail', contentType: 'text/plain', status: 500 },
});

const post = (provider = 'stripe', body = '{}', headers: Record<string, string> = {}) =>
  POST(
    new Request('https://app.test/api/wallet/callback/stripe', {
      method: 'POST',
      headers,
      body,
    }),
    { params: Promise.resolve({ provider }) }
  );

beforeEach(() => {
  getCallbackPaymentProviderMock.mockReset();
  creditPaidOrderMock.mockReset();
  handlePaymentReversalMock.mockReset();
  logSystemEventMock.mockReset();
  enforceRateLimitMock.mockReset().mockResolvedValue(null);
  resolveRequestClientIpMock.mockReset().mockReturnValue('1.2.3.4');
});

describe('回调路由门禁（P6-2）', () => {
  it('▶ 按 IP 限流：被限流时直接回 429，不碰任何 DB', async () => {
    enforceRateLimitMock.mockResolvedValue(
      NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    );
    const res = await post();
    expect(res.status).toBe(429);
    expect(getCallbackPaymentProviderMock).not.toHaveBeenCalled();
    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'wallet:callback' })
    );
  });

  it('▶ Content-Length 超上界 → 413，验签前就拒（三家通知都是小报文）', async () => {
    const res = await post('stripe', '{}', { 'content-length': String(64 * 1024 + 1) });
    expect(res.status).toBe(413);
    expect(getCallbackPaymentProviderMock).not.toHaveBeenCalled();
  });

  it('▶ 验签失败的审计日志按 (渠道,IP) 去重，不给未认证请求无限写 AuditLog', async () => {
    getCallbackPaymentProviderMock.mockResolvedValue(stripeLikeProvider(null));
    resolveRequestClientIpMock.mockReturnValue('9.9.9.9');

    await post();
    await post();
    await post();
    expect(logSystemEventMock).toHaveBeenCalledTimes(1);

    // 换个 IP → 独立计数（真出事时仍看得见）
    resolveRequestClientIpMock.mockReturnValue('9.9.9.10');
    await post();
    expect(logSystemEventMock).toHaveBeenCalledTimes(2);
  });

  it('▶ 验签失败对 Stripe 回 500（P3-3：回 200 会让它永不重试）', async () => {
    getCallbackPaymentProviderMock.mockResolvedValue(stripeLikeProvider(null));
    resolveRequestClientIpMock.mockReturnValue('8.8.8.8');
    expect((await post()).status).toBe(500);
  });
});

describe('回调路由分流', () => {
  it('▶ 渠道装配走 getCallbackPaymentProvider（P3-11：忽略 enabled 开关）', async () => {
    getCallbackPaymentProviderMock.mockResolvedValue(
      stripeLikeProvider({ outTradeNo: 'LL1', paid: true, amountCents: 3900, currency: 'CNY' })
    );
    creditPaidOrderMock.mockResolvedValue({ ok: true, alreadyProcessed: false });

    const res = await post();
    expect(res.status).toBe(200);
    expect(getCallbackPaymentProviderMock).toHaveBeenCalledWith('stripe');
    // 网关币种要一路带到对账（P3-15）
    expect(creditPaidOrderMock).toHaveBeenCalledWith('LL1', undefined, 'stripe', 3900, 'CNY');
  });

  it('▶ 到账失败 → 回失败 ACK 让网关重投', async () => {
    getCallbackPaymentProviderMock.mockResolvedValue(
      stripeLikeProvider({ outTradeNo: 'LL1', paid: true, amountCents: 3900 })
    );
    creditPaidOrderMock.mockResolvedValue({ ok: false, alreadyProcessed: false });
    expect((await post()).status).toBe(500);
  });

  it('▶ 退款通知 → 走反向流程，绝不调 creditPaidOrder（P3-16）', async () => {
    getCallbackPaymentProviderMock.mockResolvedValue(
      stripeLikeProvider({
        outTradeNo: 'LL1',
        paid: false,
        reversal: true,
        rawStatus: 'charge.refunded',
      })
    );
    handlePaymentReversalMock.mockResolvedValue({ handled: true, outcome: 'reversed' });

    const res = await post();
    expect(res.status).toBe(200);
    expect(creditPaidOrderMock).not.toHaveBeenCalled();
    expect(handlePaymentReversalMock).toHaveBeenCalledWith(
      expect.objectContaining({ outTradeNo: 'LL1', provider: 'stripe', rawStatus: 'charge.refunded' })
    );
  });

  it('▶ 反向处理失败 → 失败 ACK（网关重投，CAS 幂等）', async () => {
    getCallbackPaymentProviderMock.mockResolvedValue(
      stripeLikeProvider({ outTradeNo: 'LL1', paid: false, reversal: true })
    );
    handlePaymentReversalMock.mockResolvedValue({ handled: false, outcome: 'not_paid' });
    expect((await post()).status).toBe(500);
  });

  it('▶ 非交易类事件（acknowledged）→ 成功 ACK 止住重推（P6-13）', async () => {
    getCallbackPaymentProviderMock.mockResolvedValue(
      stripeLikeProvider({ outTradeNo: '', paid: false, acknowledged: true })
    );
    const res = await post('wechat');
    expect(res.status).toBe(200);
    expect(creditPaidOrderMock).not.toHaveBeenCalled();
    expect(handlePaymentReversalMock).not.toHaveBeenCalled();
  });

  it('▶ 未知渠道名 → 400，且不触碰限流/DB', async () => {
    const res = await post('paypal');
    expect(res.status).toBe(400);
    expect(enforceRateLimitMock).not.toHaveBeenCalled();
  });
});
