import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

/**
 * B1 统一释放原语 settleAsyncReservation：FOR UPDATE 读当前 asyncReservedMinutes → 若>0 清零列
 * + releaseTranscriptionMinutes，恰好一次。并发多路径经此原语只有一个读到>0 并释放。
 */

const { transactionMock, queryRawMock, sessionUpdateMock, executeRawMock } =
  vi.hoisted(() => ({
    transactionMock: vi.fn(),
    queryRawMock: vi.fn(),
    sessionUpdateMock: vi.fn(),
    executeRawMock: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    // settle 默认自开事务；quota.ts 其它函数在本用例不被调用，无需其余 prisma 方法。
    $transaction: (...a: unknown[]) => transactionMock(...a),
  },
}));

vi.mock('@/lib/billing', () => ({
  getBillableMinutes: (ms: number) => Math.ceil(ms / 60_000),
  getNextQuotaResetAt: () => new Date('2099-01-01T00:00:00.000Z'),
  getQuotaCycleStartAt: () => new Date('2026-01-01T00:00:00.000Z'),
  getRemainingTranscriptionMinutes: (u: number, l: number) => Math.max(0, l - u),
}));

import { settleAsyncReservation } from '@/lib/quota';

type Tx = Prisma.TransactionClient;

function makeTx() {
  return {
    $queryRaw: (...a: unknown[]) => queryRawMock(...a),
    session: { update: (...a: unknown[]) => sessionUpdateMock(...a) },
    $executeRaw: (...a: unknown[]) => executeRawMock(...a),
  };
}

describe('settleAsyncReservation', () => {
  beforeEach(() => {
    transactionMock.mockReset();
    queryRawMock.mockReset();
    sessionUpdateMock.mockReset();
    executeRawMock.mockReset();
    transactionMock.mockImplementation(
      async (run: (tx: unknown) => Promise<unknown>) => run(makeTx())
    );
    sessionUpdateMock.mockResolvedValue(undefined);
    executeRawMock.mockResolvedValue(1);
  });

  it('FOR UPDATE 读到预留(7)>0 → 清零列 + release，返回 7', async () => {
    queryRawMock.mockResolvedValueOnce([{ userId: 'u1', asyncReservedMinutes: 7 }]);

    const released = await settleAsyncReservation('s1');

    expect(released).toBe(7);
    expect(sessionUpdateMock).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { asyncReservedMinutes: 0 },
    });
    // releaseTranscriptionMinutes 的 GREATEST 扣减走 tx.$executeRaw
    expect(executeRawMock).toHaveBeenCalled();
  });

  it('列=0 → 不清、不 release，返回 0（并发已结算/本就无预留）', async () => {
    queryRawMock.mockResolvedValueOnce([{ userId: 'u1', asyncReservedMinutes: 0 }]);

    expect(await settleAsyncReservation('s1')).toBe(0);
    expect(sessionUpdateMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('行不存在 → 返回 0', async () => {
    queryRawMock.mockResolvedValueOnce([]);

    expect(await settleAsyncReservation('s1')).toBe(0);
    expect(sessionUpdateMock).not.toHaveBeenCalled();
  });

  it('传入 tx（已在外层事务内）→ 不再自开事务，直接在该 tx 上跑', async () => {
    queryRawMock.mockResolvedValueOnce([{ userId: 'u1', asyncReservedMinutes: 5 }]);

    const released = await settleAsyncReservation('s1', makeTx() as unknown as Tx);

    expect(released).toBe(5);
    // tx 无 $transaction 方法 → 不调用 prisma.$transaction
    expect(transactionMock).not.toHaveBeenCalled();
  });
});
