import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B1 兜底：releaseOrphanAsyncReservations —— 释放「已终态却仍残留在途预留」的异步上传会话。
 * 扫 findMany 命中的每个会话都过 settleAsyncReservation（FOR UPDATE 读列→清零+释放，恰好一次）；
 * 释放额 >0 计数。
 */

const {
  sessionFindManyMock,
  settleAsyncReservationMock,
} = vi.hoisted(() => ({
  sessionFindManyMock: vi.fn(),
  settleAsyncReservationMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { findMany: sessionFindManyMock },
  },
}));
vi.mock('@/lib/quota', () => ({
  resetExpiredTranscriptionQuotas: vi.fn(),
  reconcileStorageBytes: vi.fn(),
  settleAsyncReservation: settleAsyncReservationMock,
}));
// billingMaintenance import 期会拉起下列模块的顶层绑定，桩占位避免真实副作用。
vi.mock('@/lib/soniox/asyncFile', () => ({
  getSonioxTranscription: vi.fn(),
  deleteSonioxFile: vi.fn(),
  deleteSonioxTranscription: vi.fn(),
  getSonioxTranscript: vi.fn(),
}));
vi.mock('@/lib/soniox/env', () => ({
  resolveSonioxRuntimeConfigAsync: vi.fn(),
}));
vi.mock('fs/promises', () => ({ default: { rm: vi.fn(async () => undefined) } }));

import { releaseOrphanAsyncReservations } from '@/lib/billingMaintenance';

const NOW = new Date('2026-07-11T12:00:00.000Z');

describe('releaseOrphanAsyncReservations（B1 兜底释放终态残留预留）', () => {
  beforeEach(() => {
    sessionFindManyMock.mockReset();
    settleAsyncReservationMock.mockReset();
    settleAsyncReservationMock.mockResolvedValue(0);
  });

  it('只扫 asyncReservedMinutes>0 且已终态且 updatedAt 陈旧的会话', async () => {
    sessionFindManyMock.mockResolvedValueOnce([]);
    await releaseOrphanAsyncReservations(NOW);
    const call = sessionFindManyMock.mock.calls[0][0];
    expect(call.where.asyncReservedMinutes).toEqual({ gt: 0 });
    expect(call.where.asyncTranscribeStatus).toEqual({
      in: ['failed', 'canceled', 'completed'],
    });
    // 30min 陈旧门槛：updatedAt <= now-30min
    expect(call.where.updatedAt.lte).toEqual(
      new Date(NOW.getTime() - 30 * 60_000)
    );
  });

  it('每个命中会话过 settleAsyncReservation；释放额>0 才计数', async () => {
    sessionFindManyMock.mockResolvedValueOnce([
      { id: 's1', userId: 'u1', asyncReservedMinutes: 7 },
      { id: 's2', userId: 'u2', asyncReservedMinutes: 3 },
    ]);
    // s1 结算释放 7；s2 已被并发路径结算 → settle 读到 0、返回 0（不重复释放）
    settleAsyncReservationMock
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(0);

    const released = await releaseOrphanAsyncReservations(NOW);

    expect(released).toBe(1);
    expect(settleAsyncReservationMock).toHaveBeenCalledWith('s1');
    expect(settleAsyncReservationMock).toHaveBeenCalledWith('s2');
  });

  it('settle 全部返回 0（已被别处结算）→ 计数 0', async () => {
    sessionFindManyMock.mockResolvedValueOnce([
      { id: 's1', userId: 'u1', asyncReservedMinutes: 7 },
    ]);
    settleAsyncReservationMock.mockResolvedValue(0);

    const released = await releaseOrphanAsyncReservations(NOW);

    expect(released).toBe(0);
  });
});
