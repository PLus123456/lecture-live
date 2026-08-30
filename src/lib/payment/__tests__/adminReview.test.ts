import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

const {
  queryRawMock,
  executeRawMock,
  transactionMock,
  securityAuditMock,
  claimWebhookEventMock,
  linkPaymentProviderObjectsMock,
  markWebhookEventFailedMock,
  markWebhookEventProcessedMock,
  handlePaymentReversalMock,
  creditPaidOrderMock,
} = vi.hoisted(
  () => ({
    queryRawMock: vi.fn(),
    executeRawMock: vi.fn(),
    transactionMock: vi.fn(),
    securityAuditMock: vi.fn(),
    claimWebhookEventMock: vi.fn(),
    linkPaymentProviderObjectsMock: vi.fn(),
    markWebhookEventFailedMock: vi.fn(),
    markWebhookEventProcessedMock: vi.fn(),
    handlePaymentReversalMock: vi.fn(),
    creditPaidOrderMock: vi.fn(),
  })
);

const tx = {
  $queryRaw: queryRawMock,
  $executeRaw: executeRawMock,
  auditLog: { create: vi.fn() },
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: queryRawMock,
    $executeRaw: executeRawMock,
    $transaction: transactionMock,
  },
}));
vi.mock('@/lib/securityAudit', () => ({ writeSecurityAudit: securityAuditMock }));
vi.mock('@/lib/payment/webhookInbox', () => ({
  claimWebhookEvent: claimWebhookEventMock,
  linkPaymentProviderObjects: linkPaymentProviderObjectsMock,
  markWebhookEventFailed: markWebhookEventFailedMock,
  markWebhookEventProcessed: markWebhookEventProcessedMock,
}));
vi.mock('@/lib/payment/refundHandling', () => ({
  handlePaymentReversal: handlePaymentReversalMock,
}));
vi.mock('@/lib/wallet', () => ({ creditPaidOrder: creditPaidOrderMock }));

import {
  applyPaymentReviewAction,
  listPaymentReviewQueue,
} from '@/lib/payment/adminReview';

const req = () =>
  new Request('https://app.test/api/admin/recharge/reviews', { method: 'POST' });
const operator = { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' };

beforeEach(() => {
  vi.clearAllMocks();
  executeRawMock.mockResolvedValue(1);
  transactionMock.mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx));
  securityAuditMock.mockResolvedValue({ requestId: 'r1', action: 'audit' });
  claimWebhookEventMock.mockResolvedValue(true);
  linkPaymentProviderObjectsMock.mockResolvedValue(undefined);
  markWebhookEventFailedMock.mockResolvedValue(undefined);
  markWebhookEventProcessedMock.mockResolvedValue(undefined);
  handlePaymentReversalMock.mockResolvedValue({ handled: true, outcome: 'reversed' });
  creditPaidOrderMock.mockResolvedValue({ ok: true, alreadyProcessed: false });
});

describe('payment review admin controls', () => {
  it('lists stale received/processing inbox rows so crash recovery is operable', async () => {
    queryRawMock.mockResolvedValue([]);
    await listPaymentReviewQueue(25);
    const webhookQuery = queryRawMock.mock.calls.find((call) =>
      String(call[0]).includes('FROM PaymentWebhookEvent')
    );
    expect(String(webhookQuery?.[0])).toMatch(
      /status = 'processing'[\s\S]*INTERVAL 5 MINUTE[\s\S]*status = 'received'[\s\S]*INTERVAL 1 MINUTE/
    );
  });

  it('locks User before debt and atomically audits a waiver without releasing holds', async () => {
    const order: string[] = [];
    queryRawMock
      .mockImplementationOnce(async () => {
        order.push('discover');
        return [{ userId: 'u1' }];
      })
      .mockImplementationOnce(async () => {
        order.push('user');
        return [{ id: 'u1' }];
      })
      .mockImplementationOnce(async () => {
        order.push('debt');
        return [
          {
            id: 'debt-1',
            userId: 'u1',
            sourceOrderId: 'order-1',
            amountCents: 3900,
            recoveredCents: 0,
            reason: 'chargeback_unrecovered',
            status: 'open',
          },
        ];
      });

    await expect(
      applyPaymentReviewAction(req(), operator, {
        action: 'waive_debt',
        id: 'debt-1',
        reason: '客服核验银行已线下结清',
      })
    ).resolves.toMatchObject({ status: 'waived' });

    expect(order).toEqual(['discover', 'user', 'debt']);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    expect(String(executeRawMock.mock.calls[0][0])).toContain('UPDATE PaymentDebt');
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'payment-review.waive-debt',
        outcome: 'SUCCESS',
        reason: '客服核验银行已线下结清',
      }),
      tx
    );
  });

  it('refuses to release a hold while any open debt remains', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ userId: 'u1', sourceOrderId: 'order-1' }])
      .mockResolvedValueOnce([{ fulfillmentStatus: 'reversed' }])
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValueOnce([
        {
          id: 'hold-1',
          userId: 'u1',
          sourceOrderId: 'order-1',
          debtId: 'debt-1',
          reason: 'chargeback_unrecovered',
          status: 'active',
        },
      ])
      .mockResolvedValueOnce([{ id: 'debt-2' }]);

    await expect(
      applyPaymentReviewAction(req(), operator, {
        action: 'release_hold',
        id: 'hold-1',
        reason: '尝试解除冻结',
      })
    ).rejects.toMatchObject({
      code: 'OPEN_DEBT_REMAINS',
      status: 409,
    });
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(securityAuditMock).not.toHaveBeenCalled();
  });

  it('releases only after debt, order review, and review-case gates are all clear', async () => {
    const lockOrder: string[] = [];
    queryRawMock
      .mockImplementationOnce(async () => {
        lockOrder.push('discover');
        return [{ userId: 'u1', sourceOrderId: 'order-1' }];
      })
      .mockImplementationOnce(async () => {
        lockOrder.push('payment-order');
        return [{ fulfillmentStatus: 'reversed' }];
      })
      .mockImplementationOnce(async () => {
        lockOrder.push('user');
        return [{ id: 'u1' }];
      })
      .mockResolvedValueOnce([
        {
          id: 'hold-1',
          userId: 'u1',
          sourceOrderId: 'order-1',
          debtId: 'debt-1',
          reason: 'chargeback_unrecovered',
          status: 'active',
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(
      applyPaymentReviewAction(req(), operator, {
        action: 'release_hold',
        id: 'hold-1',
        reason: '债务及关联复核均已完成',
      })
    ).resolves.toMatchObject({ status: 'released' });
    expect(lockOrder).toEqual(['discover', 'payment-order', 'user']);
    expect(String(executeRawMock.mock.calls[0][0])).toContain(
      'UPDATE PaymentAccountHold'
    );
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ event: 'payment-review.release-hold' }),
      tx
    );
  });

  it('resolves a legacy refund and its hold/cases only after order→User locks and no debt', async () => {
    const order: string[] = [];
    queryRawMock
      .mockImplementationOnce(async () => {
        order.push('discover');
        return [{ userId: 'u1' }];
      })
      .mockImplementationOnce(async () => {
        order.push('payment-order');
        return [
          {
            id: 'order-1',
            userId: 'u1',
            status: 'refunded',
            refundedAt: new Date(),
            fulfillmentStatus: 'review',
            reviewReason: 'legacy_refund_unresolved',
          },
        ];
      })
      .mockImplementationOnce(async () => {
        order.push('user');
        return [{ id: 'u1' }];
      })
      .mockImplementationOnce(async () => {
        order.push('debt');
        return [];
      })
      .mockImplementationOnce(async () => {
        order.push('hold');
        return [{ id: 'hold-1' }];
      })
      .mockImplementationOnce(async () => {
        order.push('review');
        return [{ id: 'review-1' }];
      });

    await expect(
      applyPaymentReviewAction(req(), operator, {
        action: 'resolve_legacy_refund',
        id: 'order-1',
        reason: '人工核对旧台账与会员期限，确认已完整追回',
      })
    ).resolves.toMatchObject({
      fulfillmentStatus: 'reversed',
      reviewReason: 'legacy_refund_manually_resolved',
    });
    expect(order).toEqual(['discover', 'payment-order', 'user', 'debt', 'hold', 'review']);
    expect(executeRawMock).toHaveBeenCalledTimes(3);
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ event: 'payment-review.resolve-legacy-refund' }),
      tx
    );
  });

  it('closes late-payment cases only after the order is refunded and fully reversed', async () => {
    const locks: string[] = [];
    queryRawMock
      .mockImplementationOnce(async () => {
        locks.push('discover');
        return [{ userId: 'u1' }];
      })
      .mockImplementationOnce(async () => {
        locks.push('payment-order');
        return [{
          id: 'order-late', userId: 'u1', status: 'refunded',
          refundedAt: new Date(), fulfillmentStatus: 'reversed',
          reviewReason: 'payment_after_expiry',
        }];
      })
      .mockImplementationOnce(async () => {
        locks.push('user');
        return [{ id: 'u1' }];
      })
      .mockImplementationOnce(async () => {
        locks.push('reviews');
        return [{
          id: 'review-late', userId: 'u1', orderId: 'order-late',
          webhookEventId: 'webhook-paid', reason: 'payment_after_expiry', status: 'open',
        }];
      })
      .mockImplementationOnce(async () => {
        locks.push('webhook');
        return [{ id: 'webhook-paid' }];
      })
      .mockImplementationOnce(async () => {
        locks.push('reviews-lock');
        return [{ id: 'review-late' }];
      });

    await expect(
      applyPaymentReviewAction(req(), operator, {
        action: 'resolve_terminal_order_review',
        id: 'order-late',
        reason: '已核验原路退款完成且从未发放任何权益',
      })
    ).resolves.toMatchObject({
      reviewReason: 'terminal_refund_review_resolved',
      resolvedReviewIds: ['review-late'],
    });
    expect(locks).toEqual([
      'discover', 'payment-order', 'user', 'reviews', 'webhook', 'reviews-lock',
    ]);
    expect(executeRawMock).toHaveBeenCalledTimes(3);
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'payment-review.resolve-terminal-order-review',
        outcome: 'SUCCESS',
      }),
      tx
    );
  });

  it('refuses to hide a late-payment case before refund/reversal is terminal', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ userId: 'u1' }])
      .mockResolvedValueOnce([{
        id: 'order-late', userId: 'u1', status: 'paid', refundedAt: null,
        fulfillmentStatus: 'review', reviewReason: 'payment_after_expiry',
      }])
      .mockResolvedValueOnce([{ id: 'u1' }]);

    await expect(
      applyPaymentReviewAction(req(), operator, {
        action: 'resolve_terminal_order_review',
        id: 'order-late',
        reason: '尚未退款时尝试关闭',
      })
    ).rejects.toMatchObject({ code: 'ORDER_NOT_TERMINALLY_REVERSED' });
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('fails the action when the in-transaction security audit cannot persist', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ userId: 'u1' }])
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValueOnce([
        {
          id: 'review-1',
          userId: 'u1',
          orderId: null,
          webhookEventId: null,
          reason: 'unknown_payment_event',
          status: 'open',
        },
      ]);
    securityAuditMock.mockRejectedValueOnce(new Error('audit down'));

    await expect(
      applyPaymentReviewAction(req(), operator, {
        action: 'resolve_review',
        id: 'review-1',
        reason: '已确认事件为无害通知',
      })
    ).rejects.toThrow('audit down');
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.any(Object),
      tx
    );
  });

  it('maps a legacy Stripe cs_* order to PI/Charge objects and reclaims the durable event', async () => {
    const payloadJson = JSON.stringify({
      reversal: true,
      providerRef: 'ch_legacy',
      rawStatus: 'charge.refunded',
      objectRefs: [
        { objectType: 'payment_intent', objectId: 'pi_legacy' },
        { objectType: 'charge', objectId: 'ch_legacy' },
      ],
    });
    const payloadSha256 = crypto
      .createHash('sha256')
      .update(payloadJson, 'utf8')
      .digest('hex');
    queryRawMock
      .mockResolvedValueOnce([{ userId: 'u1' }])
      .mockResolvedValueOnce([
        {
          id: 'order-1',
          userId: 'u1',
          provider: 'stripe',
          providerMode: 'unknown',
          providerAccount: 'default',
          outTradeNo: 'LLLEGACY',
          providerRef: 'cs_legacy',
          providerCheckoutSessionRef: 'cs_legacy',
          status: 'paid',
          refundedAt: null,
          fulfillmentStatus: 'fulfilled',
          reviewReason: null,
        },
      ])
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValueOnce([
        {
          id: 'webhook-1',
          provider: 'stripe',
          providerMode: 'live',
          providerAccount: 'default',
          eventId: 'evt_refund_legacy',
          eventType: 'charge.refunded',
          status: 'review',
          attempts: 1,
          payloadSha256,
          payloadJson,
          updatedAt: new Date(),
        },
      ])
      // Post-reversal review-case cleanup transaction.
      .mockResolvedValueOnce([{ id: 'order-1', userId: 'u1' }])
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValueOnce([{ id: 'review-1' }]);

    await expect(
      applyPaymentReviewAction(req(), operator, {
        action: 'map_and_retry_webhook',
        id: 'webhook-1',
        orderId: 'order-1',
        reason: '从旧 Checkout Session 对账确认 PI 与 Charge 属于该订单',
      })
    ).resolves.toMatchObject({
      webhookEventId: 'webhook-1',
      orderId: 'order-1',
      outcome: 'reversed',
      mappedObjectRefs: [
        { objectType: 'payment_intent', objectId: 'pi_legacy' },
        { objectType: 'charge', objectId: 'ch_legacy' },
      ],
    });

    expect(linkPaymentProviderObjectsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'stripe',
        providerMode: 'live',
        providerAccount: 'default',
        orderId: 'order-1',
        objectRefs: [
          { objectType: 'payment_intent', objectId: 'pi_legacy' },
          { objectType: 'charge', objectId: 'ch_legacy' },
        ],
        db: tx,
      })
    );
    expect(claimWebhookEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'webhook-1', status: 'review' })
    );
    expect(handlePaymentReversalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outTradeNo: 'LLLEGACY',
        provider: 'stripe',
        providerMode: 'live',
        providerAccount: 'default',
        rawStatus: 'charge.refunded',
        providerRef: 'ch_legacy',
      })
    );
    expect(markWebhookEventProcessedMock).toHaveBeenCalledWith('webhook-1');
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'payment-review.map-and-retry-webhook',
        outcome: 'SUCCESS',
      }),
      tx
    );
  });

  it('rejects a tampered durable payload before linking provider objects', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ userId: 'u1' }])
      .mockResolvedValueOnce([
        {
          id: 'order-1',
          userId: 'u1',
          provider: 'stripe',
          providerMode: 'live',
          providerAccount: 'default',
          outTradeNo: 'LL1',
          providerRef: 'cs_1',
          providerCheckoutSessionRef: 'cs_1',
          status: 'paid',
          refundedAt: null,
          fulfillmentStatus: 'fulfilled',
          reviewReason: null,
        },
      ])
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValueOnce([
        {
          id: 'webhook-1',
          provider: 'stripe',
          providerMode: 'live',
          providerAccount: 'default',
          eventId: 'evt_1',
          eventType: 'charge.refunded',
          status: 'review',
          attempts: 1,
          payloadSha256: '0'.repeat(64),
          payloadJson: JSON.stringify({
            reversal: true,
            objectRefs: [{ objectType: 'charge', objectId: 'ch_1' }],
          }),
          updatedAt: new Date(),
        },
      ]);

    await expect(
      applyPaymentReviewAction(req(), operator, {
        action: 'map_and_retry_webhook',
        id: 'webhook-1',
        orderId: 'order-1',
        reason: '人工映射',
      })
    ).rejects.toMatchObject({ code: 'WEBHOOK_PAYLOAD_TAMPERED' });
    expect(linkPaymentProviderObjectsMock).not.toHaveBeenCalled();
    expect(claimWebhookEventMock).not.toHaveBeenCalled();
  });

  it('maps and replays a paid event with amount/currency/time evidence', async () => {
    const occurredAt = '2026-08-20T10:00:00.000Z';
    const payloadJson = JSON.stringify({
      paid: true,
      amountCents: 3900,
      currency: 'USD',
      occurredAt,
      providerRef: 'pi_paid',
      rawStatus: 'payment_intent.succeeded',
      objectRefs: [
        { objectType: 'payment_intent', objectId: 'pi_paid' },
        { objectType: 'charge', objectId: 'ch_paid' },
      ],
    });
    const payloadSha256 = crypto
      .createHash('sha256')
      .update(payloadJson, 'utf8')
      .digest('hex');
    queryRawMock
      .mockResolvedValueOnce([{ userId: 'u1' }])
      .mockResolvedValueOnce([
        {
          id: 'order-1',
          userId: 'u1',
          provider: 'stripe',
          providerMode: 'live',
          providerAccount: 'default',
          outTradeNo: 'LLPAID',
          providerRef: 'cs_paid',
          providerCheckoutSessionRef: 'cs_paid',
          amountCents: 3900,
          currency: 'USD',
          status: 'pending',
          refundedAt: null,
          fulfillmentStatus: 'pending',
          reviewReason: null,
        },
      ])
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValueOnce([
        {
          id: 'webhook-paid',
          provider: 'stripe',
          providerMode: 'live',
          providerAccount: 'default',
          eventId: 'evt_paid',
          eventType: 'payment_intent.succeeded',
          status: 'review',
          attempts: 1,
          payloadSha256,
          payloadJson,
          updatedAt: new Date(),
        },
      ])
      .mockResolvedValueOnce([{ id: 'order-1', userId: 'u1' }])
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValueOnce([{ id: 'review-paid' }]);

    await expect(
      applyPaymentReviewAction(req(), operator, {
        action: 'map_and_retry_webhook',
        id: 'webhook-paid',
        orderId: 'order-1',
        reason: '人工核对 Stripe Dashboard 后补全历史对象映射',
      })
    ).resolves.toMatchObject({ outcome: 'credited' });
    expect(creditPaidOrderMock).toHaveBeenCalledWith(
      'LLPAID',
      'pi_paid',
      'stripe',
      3900,
      'USD',
      new Date(occurredAt)
    );
    expect(handlePaymentReversalMock).not.toHaveBeenCalled();
    expect(markWebhookEventProcessedMock).toHaveBeenCalledWith('webhook-paid');
  });

  it('dismisses an orderless harmless webhook and its case atomically', async () => {
    const payloadJson = JSON.stringify({
      paid: false,
      objectRefs: [],
      rawStatus: 'future.harmless',
    });
    const payloadSha256 = crypto
      .createHash('sha256')
      .update(payloadJson, 'utf8')
      .digest('hex');
    queryRawMock
      .mockResolvedValueOnce([
        {
          id: 'webhook-harmless',
          provider: 'stripe',
          providerMode: 'live',
          providerAccount: 'default',
          eventId: 'evt_harmless',
          eventType: 'future.harmless',
          status: 'review',
          attempts: 1,
          payloadSha256,
          payloadJson,
          updatedAt: new Date(),
        },
      ])
      .mockResolvedValueOnce([
        { id: 'review-harmless', userId: null, orderId: null },
      ]);

    await expect(
      applyPaymentReviewAction(req(), operator, {
        action: 'dismiss_webhook',
        id: 'webhook-harmless',
        reason: '已核对官方事件语义，不影响本地资金或权益',
      })
    ).resolves.toMatchObject({ status: 'processed', reviews: 'dismissed' });
    expect(executeRawMock).toHaveBeenCalledTimes(2);
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'payment-review.dismiss-webhook',
        outcome: 'SUCCESS',
      }),
      tx
    );
  });

  it('rejects signed order-number or paid amount mismatch before durable object linking', async () => {
    const payloadJson = JSON.stringify({
      outTradeNo: 'LL-OTHER',
      paid: true,
      amountCents: 1,
      currency: 'USD',
      occurredAt: '2026-08-20T10:00:00.000Z',
      objectRefs: [{ objectType: 'payment_intent', objectId: 'pi_wrong' }],
    });
    const payloadSha256 = crypto
      .createHash('sha256')
      .update(payloadJson, 'utf8')
      .digest('hex');
    queryRawMock
      .mockResolvedValueOnce([{ userId: 'u1' }])
      .mockResolvedValueOnce([{
        id: 'order-1', userId: 'u1', provider: 'stripe', providerMode: 'live',
        providerAccount: 'default', outTradeNo: 'LL1', providerRef: 'cs_1',
        providerCheckoutSessionRef: 'cs_1', amountCents: 3900, currency: 'USD',
        status: 'pending', refundedAt: null, fulfillmentStatus: 'pending', reviewReason: null,
      }])
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValueOnce([{
        id: 'webhook-1', provider: 'stripe', providerMode: 'live',
        providerAccount: 'default', eventId: 'evt_1', eventType: 'payment_intent.succeeded',
        status: 'review', attempts: 1, payloadSha256, payloadJson, updatedAt: new Date(),
      }]);

    await expect(
      applyPaymentReviewAction(req(), operator, {
        action: 'map_and_retry_webhook', id: 'webhook-1', orderId: 'order-1',
        reason: '错误选择订单的反向测试',
      })
    ).rejects.toMatchObject({ code: 'OUT_TRADE_NO_MISMATCH' });
    expect(linkPaymentProviderObjectsMock).not.toHaveBeenCalled();
  });

  it('rejects Stripe Connect account mapping because this deployment has no Connect config', async () => {
    const payloadJson = JSON.stringify({
      reversal: true,
      objectRefs: [{ objectType: 'charge', objectId: 'ch_connect' }],
    });
    const payloadSha256 = crypto
      .createHash('sha256')
      .update(payloadJson, 'utf8')
      .digest('hex');
    queryRawMock
      .mockResolvedValueOnce([{ userId: 'u1' }])
      .mockResolvedValueOnce([
        {
          id: 'order-1', userId: 'u1', provider: 'stripe', providerMode: 'unknown',
          providerAccount: 'default', outTradeNo: 'LL1', providerRef: 'cs_1',
          providerCheckoutSessionRef: 'cs_1', status: 'paid', refundedAt: null,
          fulfillmentStatus: 'fulfilled', reviewReason: null,
        },
      ])
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValueOnce([
        {
          id: 'webhook-1', provider: 'stripe', providerMode: 'live',
          providerAccount: 'acct_unconfigured', eventId: 'evt_1',
          eventType: 'charge.refunded', status: 'review', attempts: 1,
          payloadSha256, payloadJson, updatedAt: new Date(),
        },
      ]);

    await expect(
      applyPaymentReviewAction(req(), operator, {
        action: 'map_and_retry_webhook',
        id: 'webhook-1',
        orderId: 'order-1',
        reason: '人工映射',
      })
    ).rejects.toMatchObject({ code: 'STRIPE_CONNECT_UNSUPPORTED' });
    expect(linkPaymentProviderObjectsMock).not.toHaveBeenCalled();
  });
});
