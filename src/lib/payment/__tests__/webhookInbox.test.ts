import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeRawMock, queryRawMock, transactionMock } = vi.hoisted(() => ({
  executeRawMock: vi.fn(),
  queryRawMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $executeRaw: executeRawMock,
    $queryRaw: queryRawMock,
    $transaction: transactionMock,
  },
}));

import {
  claimWebhookEvent,
  linkPaymentProviderObjects,
  normalizeVerifiedWebhook,
  persistVerifiedWebhookEvent,
  resolvePaymentOrderReference,
} from '@/lib/payment/webhookInbox';

beforeEach(() => {
  executeRawMock.mockReset().mockResolvedValue(1);
  queryRawMock.mockReset();
  transactionMock.mockReset().mockImplementation((fn) =>
    fn({ $executeRaw: executeRawMock, $queryRaw: queryRawMock })
  );
});

describe('payment webhook durable inbox (SEC-026)', () => {
  it('stores only a bounded normalized projection and hashes the raw delivery for fallback id', () => {
    const first = normalizeVerifiedWebhook(
      'stripe',
      {
        outTradeNo: 'LL1',
        paid: false,
        reversal: true,
        eventType: 'charge.dispute.created',
        providerMode: 'live',
        providerAccount: 'acct_1',
        objectRefs: [
          { objectType: 'dispute', objectId: 'dp_1' },
          { objectType: 'charge', objectId: 'ch_1' },
        ],
      },
      'raw-body-containing-a-signature-or-secret'
    );
    const second = normalizeVerifiedWebhook(
      'stripe',
      {
        outTradeNo: 'LL1',
        paid: false,
        reversal: true,
        eventType: 'charge.dispute.created',
        providerMode: 'live',
        providerAccount: 'acct_1',
        objectRefs: [
          { objectType: 'dispute', objectId: 'dp_1' },
          { objectType: 'charge', objectId: 'ch_1' },
        ],
      },
      'raw-body-containing-a-signature-or-secret'
    );

    expect(first.identity.eventId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.identity.eventId).toBe(second.identity.eventId);
    expect(first.payloadJson).not.toContain('raw-body-containing');
    expect(Buffer.byteLength(first.payloadJson)).toBeLessThanOrEqual(16 * 1024);
    expect(JSON.parse(first.payloadJson).objectRefs).toHaveLength(2);
  });

  it('rejects an event-id replay whose normalized payload changed', async () => {
    queryRawMock.mockResolvedValueOnce([
      {
        id: 'row-1',
        provider: 'stripe',
        providerMode: 'live',
        providerAccount: 'default',
        eventId: 'evt_1',
        eventType: 'checkout.session.completed',
        status: 'received',
        attempts: 0,
        payloadSha256: '0'.repeat(64),
      },
    ]);

    await expect(
      persistVerifiedWebhookEvent({
        provider: 'stripe',
        result: {
          outTradeNo: 'LL1',
          paid: true,
          eventId: 'evt_1',
          eventType: 'checkout.session.completed',
          providerMode: 'live',
        },
        rawFingerprintSource: '{}',
      })
    ).rejects.toThrow(/identity collision/i);
  });

  it('does not overwrite a provider object already mapped to another order', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ id: 'attacker-order' }])
      .mockResolvedValueOnce([{ orderId: 'victim-order' }]);
    await expect(
      linkPaymentProviderObjects({
        provider: 'stripe',
        providerMode: 'live',
        providerAccount: 'acct_1',
        orderId: 'attacker-order',
        objectRefs: [{ objectType: 'charge', objectId: 'ch_same' }],
      })
    ).rejects.toThrow(/another order/i);
  });

  it('wraps all refs in one transaction so a late conflict rolls back earlier mappings', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ id: 'order-1' }])
      // Refs are sorted Charge before PaymentIntent, so make the later PI conflict.
      .mockResolvedValueOnce([{ orderId: 'order-1' }])
      .mockResolvedValueOnce([{ orderId: 'victim-order' }]);

    await expect(
      linkPaymentProviderObjects({
        provider: 'stripe',
        providerMode: 'live',
        providerAccount: 'default',
        orderId: 'order-1',
        objectRefs: [
          { objectType: 'payment_intent', objectId: 'pi_conflict' },
          { objectType: 'charge', objectId: 'ch_1' },
        ],
      })
    ).rejects.toThrow(/another order/i);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(executeRawMock).toHaveBeenCalled();
    // Rejection escapes the transaction callback; Prisma therefore rolls back the first PI insert.
    await expect(transactionMock.mock.results[0].value).rejects.toThrow(/another order/i);
  });

  it('locks the order first and sorts reverse-ordered refs into one global object lock order', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ id: 'order-1' }])
      .mockResolvedValueOnce([{ orderId: 'order-1' }])
      .mockResolvedValueOnce([{ orderId: 'order-1' }]);

    await linkPaymentProviderObjects({
      provider: 'stripe',
      providerMode: 'live',
      providerAccount: 'default',
      orderId: 'order-1',
      objectRefs: [
        { objectType: 'payment_intent', objectId: 'pi_1' },
        { objectType: 'charge', objectId: 'ch_1' },
      ],
    });

    expect(String(queryRawMock.mock.calls[0][0])).toMatch(
      /FROM PaymentOrder[\s\S]*FOR UPDATE/
    );
    const insertValues = executeRawMock.mock.calls
      .filter((call) => String(call[0]).includes('INSERT IGNORE INTO PaymentProviderObject'))
      .map((call) => call.slice(1));
    expect(insertValues[0]).toEqual(expect.arrayContaining(['charge', 'ch_1']));
    expect(insertValues[1]).toEqual(
      expect.arrayContaining(['payment_intent', 'pi_1'])
    );
  });

  it('resolves direct metadata only inside the exact provider/mode/account namespace', async () => {
    queryRawMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await resolvePaymentOrderReference({
      provider: 'stripe',
      providerMode: 'test',
      providerAccount: 'acct_test',
      outTradeNo: 'LL1',
    });

    const [template, ...values] = queryRawMock.mock.calls[0];
    expect(String(template)).toContain('providerMode');
    expect(values).toEqual(expect.arrayContaining(['LL1', 'stripe', 'test', 'acct_test']));
  });

  it('binds a pre-migration unknown/default order once from a verified signed namespace', async () => {
    const promoted = {
      id: 'legacy-order',
      outTradeNo: 'LLLEGACY',
      userId: 'u1',
      provider: 'stripe',
      providerMode: 'live',
      providerAccount: 'default',
    };
    queryRawMock.mockResolvedValueOnce([]).mockResolvedValueOnce([promoted]);

    await expect(
      resolvePaymentOrderReference({
        provider: 'stripe',
        providerMode: 'live',
        providerAccount: 'default',
        outTradeNo: 'LLLEGACY',
      })
    ).resolves.toEqual(promoted);

    const [template, ...values] = executeRawMock.mock.calls[0];
    expect(String(template)).toMatch(/providerMode = 'unknown'[\s\S]*providerAccount = 'default'/);
    expect(values).toEqual(
      expect.arrayContaining(['live', 'default', 'LLLEGACY', 'stripe'])
    );
  });

  it('never promotes a legacy order from an unknown callback namespace', async () => {
    queryRawMock.mockResolvedValueOnce([]);

    await expect(
      resolvePaymentOrderReference({
        provider: 'stripe',
        providerMode: 'unknown',
        providerAccount: 'default',
        outTradeNo: 'LLLEGACY',
      })
    ).resolves.toBeNull();
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('never lets an unconfigured Stripe Connect account adopt a legacy default order', async () => {
    queryRawMock.mockResolvedValueOnce([]);

    await expect(
      resolvePaymentOrderReference({
        provider: 'stripe',
        providerMode: 'live',
        providerAccount: 'acct_attacker',
        outTradeNo: 'LLLEGACY',
      })
    ).resolves.toBeNull();
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('only the atomic inbox claim winner may process the event', async () => {
    const event = {
      id: 'row-1',
      provider: 'stripe' as const,
      providerMode: 'live' as const,
      providerAccount: 'default',
      eventId: 'evt_1',
      eventType: 'charge.refunded',
      status: 'received' as const,
      attempts: 0,
      payloadSha256: 'a'.repeat(64),
    };
    executeRawMock.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(claimWebhookEvent(event)).resolves.toBe(true);
    await expect(claimWebhookEvent(event)).resolves.toBe(false);
  });
});
