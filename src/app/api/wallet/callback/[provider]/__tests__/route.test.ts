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
  persistVerifiedWebhookEventMock,
  claimWebhookEventMock,
  resolvePaymentOrderReferenceMock,
  linkPaymentProviderObjectsMock,
  markWebhookEventProcessedMock,
  markWebhookEventFailedMock,
  openPaymentReviewCaseMock,
  settleStripePendingReversalMock,
} = vi.hoisted(() => ({
  getCallbackPaymentProviderMock: vi.fn(),
  creditPaidOrderMock: vi.fn(),
  handlePaymentReversalMock: vi.fn(),
  logSystemEventMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  resolveRequestClientIpMock: vi.fn(),
  persistVerifiedWebhookEventMock: vi.fn(),
  claimWebhookEventMock: vi.fn(),
  resolvePaymentOrderReferenceMock: vi.fn(),
  linkPaymentProviderObjectsMock: vi.fn(),
  markWebhookEventProcessedMock: vi.fn(),
  markWebhookEventFailedMock: vi.fn(),
  openPaymentReviewCaseMock: vi.fn(),
  settleStripePendingReversalMock: vi.fn(),
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
vi.mock('@/lib/payment/webhookInbox', () => ({
  persistVerifiedWebhookEvent: persistVerifiedWebhookEventMock,
  claimWebhookEvent: claimWebhookEventMock,
  resolvePaymentOrderReference: resolvePaymentOrderReferenceMock,
  linkPaymentProviderObjects: linkPaymentProviderObjectsMock,
  markWebhookEventProcessed: markWebhookEventProcessedMock,
  markWebhookEventFailed: markWebhookEventFailedMock,
  openPaymentReviewCase: openPaymentReviewCaseMock,
  settleStripePendingReversal: settleStripePendingReversalMock,
}));

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
  persistVerifiedWebhookEventMock.mockReset().mockResolvedValue({
    id: 'evt-row-1',
    provider: 'stripe',
    providerMode: 'unknown',
    providerAccount: 'default',
    eventId: 'evt_1',
    eventType: 'test.event',
    status: 'received',
    attempts: 0,
    payloadSha256: 'a'.repeat(64),
  });
  claimWebhookEventMock.mockReset().mockResolvedValue(true);
  resolvePaymentOrderReferenceMock.mockReset().mockResolvedValue({
    id: 'o1',
    outTradeNo: 'LL1',
    userId: 'u1',
    provider: 'stripe',
    providerMode: 'unknown',
    providerAccount: 'default',
  });
  linkPaymentProviderObjectsMock.mockReset().mockResolvedValue(undefined);
  markWebhookEventProcessedMock.mockReset().mockResolvedValue(undefined);
  markWebhookEventFailedMock.mockReset().mockResolvedValue(undefined);
  openPaymentReviewCaseMock.mockReset().mockResolvedValue(undefined);
  settleStripePendingReversalMock.mockReset().mockResolvedValue(undefined);
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
  it('▶ durable inbox 写入失败 → 绝不成功 ACK、绝不触碰到账', async () => {
    getCallbackPaymentProviderMock.mockResolvedValue(
      stripeLikeProvider({ outTradeNo: 'LL1', paid: true })
    );
    persistVerifiedWebhookEventMock.mockRejectedValueOnce(new Error('db down'));

    expect((await post()).status).toBe(500);
    expect(creditPaidOrderMock).not.toHaveBeenCalled();
  });

  it('▶ 渠道装配走 getCallbackPaymentProvider（P3-11：忽略 enabled 开关）', async () => {
    getCallbackPaymentProviderMock.mockResolvedValue(
      stripeLikeProvider({ outTradeNo: 'LL1', paid: true, amountCents: 3900, currency: 'CNY' })
    );
    creditPaidOrderMock.mockResolvedValue({ ok: true, alreadyProcessed: false });

    const res = await post();
    expect(res.status).toBe(200);
    expect(getCallbackPaymentProviderMock).toHaveBeenCalledWith('stripe');
    // 网关币种要一路带到对账（P3-15）
    expect(creditPaidOrderMock).toHaveBeenCalledWith(
      'LL1',
      undefined,
      'stripe',
      3900,
      'CNY',
      undefined
    );
  });

  it('▶ 到账失败 → 回失败 ACK 让网关重投', async () => {
    getCallbackPaymentProviderMock.mockResolvedValue(
      stripeLikeProvider({ outTradeNo: 'LL1', paid: true, amountCents: 3900 })
    );
    creditPaidOrderMock.mockResolvedValue({ ok: false, alreadyProcessed: false });
    expect((await post()).status).toBe(500);
  });

  it('▶ SEC-029 late_paid 已 durable review → 成功 ACK，但不冒充到账成功', async () => {
    getCallbackPaymentProviderMock.mockResolvedValue(
      stripeLikeProvider({ outTradeNo: 'LL1', paid: true, amountCents: 3900 })
    );
    creditPaidOrderMock.mockResolvedValue({
      ok: false,
      acknowledged: true,
      alreadyProcessed: false,
      status: 'late_paid',
    });

    expect((await post()).status).toBe(200);
    expect(openPaymentReviewCaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'payment_after_expiry', orderId: 'o1' })
    );
    expect(markWebhookEventProcessedMock).toHaveBeenCalledWith('evt-row-1');
    expect(markWebhookEventFailedMock).not.toHaveBeenCalled();
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

  it('▶ pending Refund 先冻结且不能提前释放 lifecycle hold', async () => {
    const occurredAt = new Date('2026-08-20T10:00:00.000Z');
    getCallbackPaymentProviderMock.mockResolvedValue(
      stripeLikeProvider({
        outTradeNo: 'LL1',
        paid: false,
        reversal: true,
        reversalState: 'pending',
        fullReversal: false,
        providerRef: 're_pending',
        providerMode: 'live',
        providerAccount: 'default',
        occurredAt,
        objectRefs: [
          { objectType: 'refund', objectId: 're_pending' },
          { objectType: 'charge', objectId: 'ch_1' },
        ],
      })
    );
    handlePaymentReversalMock.mockResolvedValue({
      handled: false,
      outcome: 'partial_review',
    });

    expect((await post()).status).toBe(500);
    expect(handlePaymentReversalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reversalState: 'pending',
        providerRef: 're_pending',
        sourceObjectType: 'refund',
        sourceObjectId: 're_pending',
        occurredAt,
      })
    );
    expect(openPaymentReviewCaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'stripe_pending_reversal' })
    );
    expect(settleStripePendingReversalMock).not.toHaveBeenCalled();
  });

  it.each([
    ['refund', 're_succeeded'],
    ['dispute', 'dp_lost'],
  ])(
    '▶ withdrawn %s terminal settles only its earlier pending resource after clawback',
    async (objectType, objectId) => {
      getCallbackPaymentProviderMock.mockResolvedValue(
        stripeLikeProvider({
          outTradeNo: 'LL1',
          paid: false,
          reversal: true,
          reversalState: 'withdrawn',
          providerRef: objectId,
          providerMode: 'live',
          providerAccount: 'default',
          objectRefs: [{ objectType, objectId }],
        })
      );
      handlePaymentReversalMock.mockResolvedValue({ handled: true, outcome: 'reversed' });

      expect((await post()).status).toBe(200);
      expect(settleStripePendingReversalMock).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'o1',
          objectType,
          objectId,
          terminalState: 'withdrawn',
        })
      );
    }
  );

  it.each([
    ['refund', 're_failed'],
    ['dispute', 'dp_won'],
  ])(
    '▶ reinstated %s terminal releases only its matching pending resource without clawback',
    async (objectType, objectId) => {
      getCallbackPaymentProviderMock.mockResolvedValue(
        stripeLikeProvider({
          outTradeNo: 'LL1',
          paid: false,
          acknowledged: true,
          reversalState: 'reinstated',
          providerRef: objectId,
          providerMode: 'live',
          providerAccount: 'default',
          objectRefs: [{ objectType, objectId }],
        })
      );

      expect((await post()).status).toBe(200);
      expect(handlePaymentReversalMock).not.toHaveBeenCalled();
      expect(settleStripePendingReversalMock).toHaveBeenCalledWith(
        expect.objectContaining({ objectType, objectId, terminalState: 'reinstated' })
      );
    }
  );

  it('▶ 无法映射的退款/拒付 → durable review + 失败 ACK，不静默吞掉', async () => {
    getCallbackPaymentProviderMock.mockResolvedValue(
      stripeLikeProvider({
        outTradeNo: '',
        paid: false,
        reversal: true,
        eventId: 'evt_dispute',
        eventType: 'charge.dispute.created',
        providerMode: 'live',
        providerAccount: 'default',
        objectRefs: [{ objectType: 'charge', objectId: 'ch_unknown' }],
      })
    );
    resolvePaymentOrderReferenceMock.mockResolvedValueOnce(null);

    expect((await post()).status).toBe(500);
    expect(openPaymentReviewCaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unresolved_reversal_object' })
    );
    expect(markWebhookEventFailedMock).toHaveBeenCalledWith(
      'evt-row-1',
      expect.any(String),
      'review'
    );
    expect(handlePaymentReversalMock).not.toHaveBeenCalled();
  });

  it('▶ 重复事件仍在 processing → 失败 ACK，避免 owner 崩溃前提前确认', async () => {
    getCallbackPaymentProviderMock.mockResolvedValue(
      stripeLikeProvider({ outTradeNo: 'LL1', paid: true })
    );
    claimWebhookEventMock.mockResolvedValueOnce(false);
    expect((await post()).status).toBe(500);
    expect(creditPaidOrderMock).not.toHaveBeenCalled();
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

  it('▶ 未知已验签事件 → durable review + 失败 ACK，不把未来事件静默当 no-op', async () => {
    getCallbackPaymentProviderMock.mockResolvedValue(
      stripeLikeProvider({
        outTradeNo: '',
        paid: false,
        eventId: 'evt_future',
        eventType: 'charge.future_reversal_semantics',
        providerMode: 'live',
      })
    );
    resolvePaymentOrderReferenceMock.mockResolvedValueOnce(null);

    expect((await post()).status).toBe(500);
    expect(openPaymentReviewCaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unknown_payment_event' })
    );
    expect(markWebhookEventFailedMock).toHaveBeenCalledWith(
      'evt-row-1',
      expect.stringContaining('harmless no-op allowlist'),
      'review'
    );
    expect(markWebhookEventProcessedMock).not.toHaveBeenCalled();
  });

  it('▶ paid 与 acknowledged 同时出现时仍必须走到账，不得被 no-op 分支吞掉', async () => {
    getCallbackPaymentProviderMock.mockResolvedValue(
      stripeLikeProvider({
        outTradeNo: 'LL1',
        paid: true,
        acknowledged: true,
        amountCents: 3900,
        currency: 'CNY',
      })
    );
    creditPaidOrderMock.mockResolvedValue({ ok: true, alreadyProcessed: false });

    expect((await post()).status).toBe(200);
    expect(creditPaidOrderMock).toHaveBeenCalledTimes(1);
    expect(markWebhookEventProcessedMock).toHaveBeenCalledWith('evt-row-1');
  });

  it('▶ 未知渠道名 → 400，且不触碰限流/DB', async () => {
    const res = await post('paypal');
    expect(res.status).toBe(400);
    expect(enforceRateLimitMock).not.toHaveBeenCalled();
  });
});
