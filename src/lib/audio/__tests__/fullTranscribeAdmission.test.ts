import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  transactionMock,
  executeRawMock,
  queryRawMock,
  countMock,
  updateMock,
  updateManyMock,
  reserveMock,
  releaseMock,
  settleFullMock,
} = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  executeRawMock: vi.fn(),
  queryRawMock: vi.fn(),
  countMock: vi.fn(),
  updateMock: vi.fn(),
  updateManyMock: vi.fn(),
  reserveMock: vi.fn(),
  releaseMock: vi.fn(),
  settleFullMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: transactionMock,
    session: { updateMany: updateManyMock },
  },
}));
vi.mock('@/lib/quota', () => ({
  reserveTranscriptionMinutes: reserveMock,
  releaseTranscriptionMinutes: releaseMock,
  settleFullReservation: settleFullMock,
}));

import {
  claimFullTranscribeTask,
  failFullTranscribeAttempt,
  failFullTranscribeClaim,
  registerFullTranscribeReservation,
  releaseTerminalFullTranscribeReservation,
} from '@/lib/audio/fullTranscribeAdmission';

const originalUserLimit = process.env.FULL_TRANSCRIBE_MAX_ACTIVE_PER_USER;
const originalGlobalLimit = process.env.FULL_TRANSCRIBE_MAX_ACTIVE_GLOBAL;

function claimRow(over: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    userId: 'u-1',
    status: 'COMPLETED',
    recordingPath: 'local:s-1.webm',
    fullTranscribeStatus: null,
    fullReservedMinutes: 0,
    ...over,
  };
}

function tx() {
  return {
    $executeRaw: executeRawMock,
    $queryRaw: queryRawMock,
    session: {
      count: countMock,
      update: updateMock,
      updateMany: updateManyMock,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FULL_TRANSCRIBE_MAX_ACTIVE_PER_USER = '1';
  process.env.FULL_TRANSCRIBE_MAX_ACTIVE_GLOBAL = '2';
  transactionMock.mockImplementation(async (callback: (client: unknown) => unknown) =>
    callback(tx())
  );
  executeRawMock.mockResolvedValue(1);
  queryRawMock
    .mockResolvedValueOnce([{ key: '__internal_full_transcribe_admission_lock__' }])
    .mockResolvedValueOnce([claimRow()]);
  countMock.mockResolvedValue(0);
  updateMock.mockResolvedValue(undefined);
  updateManyMock.mockResolvedValue({ count: 1 });
  reserveMock.mockResolvedValue(true);
  releaseMock.mockResolvedValue(undefined);
  settleFullMock.mockResolvedValue(0);
});

afterEach(() => {
  if (originalUserLimit === undefined) {
    delete process.env.FULL_TRANSCRIBE_MAX_ACTIVE_PER_USER;
  } else {
    process.env.FULL_TRANSCRIBE_MAX_ACTIVE_PER_USER = originalUserLimit;
  }
  if (originalGlobalLimit === undefined) {
    delete process.env.FULL_TRANSCRIBE_MAX_ACTIVE_GLOBAL;
  } else {
    process.env.FULL_TRANSCRIBE_MAX_ACTIVE_GLOBAL = originalGlobalLimit;
  }
});

describe('full-transcribe durable admission', () => {
  it('locks the global sentinel, revalidates Session, checks budgets, then records claim', async () => {
    const outcome = await claimFullTranscribeTask('s-1', 'u-1');

    expect(outcome.outcome).toBe('claimed');
    expect(executeRawMock).toHaveBeenCalledOnce();
    expect(queryRawMock).toHaveBeenCalledTimes(2);
    expect(countMock).toHaveBeenNthCalledWith(1, {
      where: {
        fullTranscribeStatus: {
          in: ['pending', 'transcoding', 'transcribing', 'finalizing'],
        },
      },
    });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 's-1' },
        data: expect.objectContaining({
          fullTranscribeStatus: 'pending',
          fullReservedMinutes: 0,
          fullTranscribeClaimId: expect.any(String),
        }),
      })
    );
    expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateMock.mock.invocationCallOrder[0]
    );
  });

  it('fails closed when the cross-process sentinel row cannot be locked', async () => {
    queryRawMock.mockReset().mockResolvedValueOnce([]);

    await expect(claimFullTranscribeTask('s-1', 'u-1')).rejects.toThrow(
      'admission lock is unavailable'
    );
    expect(countMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('enforces global and per-user active-task budgets before claiming', async () => {
    countMock.mockResolvedValueOnce(2);
    await expect(claimFullTranscribeTask('s-1', 'u-1')).resolves.toEqual({
      outcome: 'global_busy',
    });
    expect(updateMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    executeRawMock.mockResolvedValue(1);
    queryRawMock
      .mockResolvedValueOnce([{ key: '__internal_full_transcribe_admission_lock__' }])
      .mockResolvedValueOnce([claimRow()]);
    countMock.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    transactionMock.mockImplementation(async (callback: (client: unknown) => unknown) =>
      callback(tx())
    );

    await expect(claimFullTranscribeTask('s-1', 'u-1')).resolves.toEqual({
      outcome: 'user_busy',
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('two serialized concurrent claims produce one winner and one already-running result', async () => {
    let status: string | null = null;
    let queue = Promise.resolve();
    transactionMock.mockImplementation((callback: (client: unknown) => Promise<unknown>) => {
      const run = queue.then(async () => {
        let queryIndex = 0;
        const dynamicTx = {
          $executeRaw: vi.fn().mockResolvedValue(1),
          $queryRaw: vi.fn(async () => {
            queryIndex += 1;
            return queryIndex === 1
              ? [{ key: '__internal_full_transcribe_admission_lock__' }]
              : [claimRow({ fullTranscribeStatus: status })];
          }),
          session: {
            count: vi.fn().mockResolvedValue(0),
            update: vi.fn(async (args: { data: { fullTranscribeStatus: string } }) => {
              status = args.data.fullTranscribeStatus;
            }),
          },
        };
        return callback(dynamicTx);
      });
      queue = run.then(() => undefined, () => undefined);
      return run;
    });

    const [first, second] = await Promise.all([
      claimFullTranscribeTask('s-1', 'u-1'),
      claimFullTranscribeTask('s-1', 'u-1'),
    ]);

    expect(first.outcome).toBe('claimed');
    expect(second).toEqual({ outcome: 'already_running', status: 'pending' });
  });

  it('retrigger atomically replaces and releases a terminal attempt reservation', async () => {
    queryRawMock.mockReset();
    queryRawMock
      .mockResolvedValueOnce([{ key: '__internal_full_transcribe_admission_lock__' }])
      .mockResolvedValueOnce([
        claimRow({ fullTranscribeStatus: 'failed', fullReservedMinutes: 5 }),
      ]);

    await expect(claimFullTranscribeTask('s-1', 'u-1')).resolves.toMatchObject({
      outcome: 'claimed',
    });

    expect(releaseMock).toHaveBeenCalledWith('u-1', 5, tx());
  });
});

describe('full-transcribe measured reservation registration', () => {
  beforeEach(() => {
    queryRawMock.mockReset().mockResolvedValue([
      {
        userId: 'u-1',
        fullTranscribeStatus: 'pending',
        fullTranscribeClaimId: 'claim-1',
      },
    ]);
  });

  it('debits quota and registers its owner in the same transaction', async () => {
    const result = await registerFullTranscribeReservation({
      sessionId: 's-1',
      userId: 'u-1',
      claimId: 'claim-1',
      durationMs: 600_000,
      estimatedMinutes: 8,
    });

    expect(result).toEqual({ outcome: 'reserved' });
    expect(reserveMock).toHaveBeenCalledWith('u-1', 8, tx());
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 's-1' },
      data: { durationMs: 600_000, fullReservedMinutes: 8 },
    });
  });

  it('rejects non-finite reservation inputs before opening a transaction', async () => {
    transactionMock.mockClear();
    await expect(
      registerFullTranscribeReservation({
        sessionId: 's-1',
        userId: 'u-1',
        claimId: 'claim-1',
        durationMs: 600_000,
        estimatedMinutes: Number.NaN,
      })
    ).rejects.toThrow('Invalid full-transcribe reservation');
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('quota rejection records measured duration and frees the active slot without a debit', async () => {
    reserveMock.mockResolvedValueOnce(false);

    const result = await registerFullTranscribeReservation({
      sessionId: 's-1',
      userId: 'u-1',
      claimId: 'claim-1',
      durationMs: 600_000,
      estimatedMinutes: 8,
    });

    expect(result).toEqual({ outcome: 'insufficient_quota' });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          durationMs: 600_000,
          fullTranscribeStatus: 'failed',
          fullReservedMinutes: 0,
        }),
      })
    );
  });

  it('claim token mismatch performs no quota operation', async () => {
    queryRawMock.mockResolvedValueOnce([
      {
        userId: 'u-1',
        fullTranscribeStatus: 'pending',
        fullTranscribeClaimId: 'new-claim',
      },
    ]);

    await expect(
      registerFullTranscribeReservation({
        sessionId: 's-1',
        userId: 'u-1',
        claimId: 'old-claim',
        durationMs: 600_000,
        estimatedMinutes: 8,
      })
    ).resolves.toEqual({ outcome: 'claim_lost' });
    expect(reserveMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('pre-processing failure updates and settles only the matching claim in one transaction', async () => {
    await expect(
      failFullTranscribeClaim({
        sessionId: 's-1',
        claimId: 'claim-1',
        error: 'decode failed',
      })
    ).resolves.toBe(true);
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 's-1',
          fullTranscribeClaimId: 'claim-1',
          fullTranscribeStatus: { in: ['pending'] },
        },
      })
    );
    expect(settleFullMock).toHaveBeenCalledWith('s-1', tx());
    expect(updateManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      settleFullMock.mock.invocationCallOrder[0]
    );
  });

  it('claim loss prevents an old failure path from releasing the new attempt reservation', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 0 });

    await expect(
      failFullTranscribeAttempt({
        sessionId: 's-1',
        claimId: 'old-claim',
        allowedStatuses: ['pending', 'transcoding'],
        error: 'old worker failed',
      })
    ).resolves.toBe(false);

    expect(settleFullMock).not.toHaveBeenCalled();
  });

  it('orphan sweep revalidates claim, terminal status and age under the Session lock', async () => {
    const staleBefore = new Date('2026-08-20T00:00:00.000Z');
    queryRawMock.mockReset().mockResolvedValueOnce([
      {
        fullTranscribeClaimId: 'new-claim',
        fullTranscribeStatus: 'pending',
        updatedAt: new Date('2026-08-19T00:00:00.000Z'),
      },
    ]);

    await expect(
      releaseTerminalFullTranscribeReservation({
        sessionId: 's-1',
        claimId: 'old-claim',
        updatedAtLte: staleBefore,
      })
    ).resolves.toBe(0);
    expect(settleFullMock).not.toHaveBeenCalled();

    queryRawMock.mockReset().mockResolvedValueOnce([
      {
        fullTranscribeClaimId: 'old-claim',
        fullTranscribeStatus: 'failed',
        updatedAt: new Date('2026-08-19T00:00:00.000Z'),
      },
    ]);
    settleFullMock.mockResolvedValueOnce(7);
    await expect(
      releaseTerminalFullTranscribeReservation({
        sessionId: 's-1',
        claimId: 'old-claim',
        updatedAtLte: staleBefore,
      })
    ).resolves.toBe(7);
    expect(settleFullMock).toHaveBeenCalledWith('s-1', tx());
  });
});
