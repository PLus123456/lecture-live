import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

/**
 * B1/R4 统一释放原语 settleReservation(sessionId, column)：FOR UPDATE 读当前列 → 若>0 清零列
 * + releaseTranscriptionMinutes，恰好一次。并发多路径经此原语只有一个读到>0 并释放。
 * settleAsyncReservation / settleFullReservation 是其具名封装（column 分别为 async / full 列）。
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

import {
  settleAsyncReservation,
  settleFullReservation,
  settleReservation,
} from '@/lib/quota';

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

describe('settleFullReservation（R4：完整版补全预留结算）', () => {
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

  it('FOR UPDATE 读到 fullReservedMinutes(4)>0 → 清 full 列 + release，返回 4', async () => {
    // row 以真实列名 fullReservedMinutes 为键（SELECT 不加别名，settle 按 row[column] 取值）。
    queryRawMock.mockResolvedValueOnce([{ userId: 'u1', fullReservedMinutes: 4 }]);

    const released = await settleFullReservation('s-full');

    expect(released).toBe(4);
    // 清的是 full 列（计算键），绝不误清 async 列。
    expect(sessionUpdateMock).toHaveBeenCalledWith({
      where: { id: 's-full' },
      data: { fullReservedMinutes: 0 },
    });
    expect(executeRawMock).toHaveBeenCalled();
  });

  it('full 列=0 → 不清、不 release，返回 0（并发已结算/本就无预留）', async () => {
    queryRawMock.mockResolvedValueOnce([{ userId: 'u1', fullReservedMinutes: 0 }]);

    expect(await settleFullReservation('s-full')).toBe(0);
    expect(sessionUpdateMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('行不存在 → 返回 0', async () => {
    queryRawMock.mockResolvedValueOnce([]);
    expect(await settleFullReservation('s-full')).toBe(0);
    expect(sessionUpdateMock).not.toHaveBeenCalled();
  });
});

describe('settleReservation（泛化原语的列门禁与取值）', () => {
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

  it('非白名单列名 → 抛错，绝不拼进 raw SQL（不查、不写）', async () => {
    await expect(
      // 故意传入非法列名，模拟任何非预期标识符
      settleReservation('s1', 'transcriptionMinutesUsed' as never)
    ).rejects.toThrow(/unsupported reservation column/);
    expect(queryRawMock).not.toHaveBeenCalled();
    expect(sessionUpdateMock).not.toHaveBeenCalled();
  });

  it('按 row[column] 取值：full 列存在但值为字符串数字仍能安全比较/释放', async () => {
    // 某些驱动可能把 INT 以 bigint/string 返回；Number() 归一后照常释放。
    queryRawMock.mockResolvedValueOnce([{ userId: 'u1', fullReservedMinutes: '6' }]);

    const released = await settleReservation('s1', 'fullReservedMinutes');

    expect(released).toBe(6);
    expect(sessionUpdateMock).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { fullReservedMinutes: 0 },
    });
  });
});
