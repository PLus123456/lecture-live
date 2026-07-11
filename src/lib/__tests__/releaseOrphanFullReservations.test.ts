import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R4 兜底：releaseOrphanFullReservations —— 释放「已终态却仍残留在途预留」的完整版补全转录会话
 *（与 B1 的 releaseOrphanAsyncReservations 平行）。扫 findMany 命中的每个会话都过 settleFullReservation
 *（FOR UPDATE 读列→清零+释放，恰好一次）；释放额 >0 计数。
 */

const {
  sessionFindManyMock,
  settleFullReservationMock,
} = vi.hoisted(() => ({
  sessionFindManyMock: vi.fn(),
  settleFullReservationMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { findMany: sessionFindManyMock },
  },
}));
vi.mock('@/lib/quota', () => ({
  resetExpiredTranscriptionQuotas: vi.fn(),
  reconcileStorageBytes: vi.fn(),
  settleAsyncReservation: vi.fn(),
  settleFullReservation: settleFullReservationMock,
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

import { releaseOrphanFullReservations } from '@/lib/billingMaintenance';

const NOW = new Date('2026-07-11T12:00:00.000Z');

describe('releaseOrphanFullReservations（R4 兜底释放终态残留预留）', () => {
  beforeEach(() => {
    sessionFindManyMock.mockReset();
    settleFullReservationMock.mockReset();
    settleFullReservationMock.mockResolvedValue(0);
  });

  it('只扫 fullReservedMinutes>0 且已终态(failed/completed)且 updatedAt 陈旧的会话', async () => {
    sessionFindManyMock.mockResolvedValueOnce([]);
    await releaseOrphanFullReservations(NOW);
    const call = sessionFindManyMock.mock.calls[0][0];
    expect(call.where.fullReservedMinutes).toEqual({ gt: 0 });
    // 完整版终态无 canceled（无用户取消路径）
    expect(call.where.fullTranscribeStatus).toEqual({
      in: ['failed', 'completed'],
    });
    // 30min 陈旧门槛：updatedAt <= now-30min，避免与刚 completed 的在途 finalize 结算赛跑
    expect(call.where.updatedAt.lte).toEqual(
      new Date(NOW.getTime() - 30 * 60_000)
    );
  });

  it('每个命中会话过 settleFullReservation；释放额>0 才计数', async () => {
    sessionFindManyMock.mockResolvedValueOnce([
      { id: 's1', userId: 'u1', fullReservedMinutes: 4 },
      { id: 's2', userId: 'u2', fullReservedMinutes: 2 },
    ]);
    // s1 结算释放 4；s2 已被并发路径结算 → settle 读到 0、返回 0（不重复释放）
    settleFullReservationMock
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(0);

    const released = await releaseOrphanFullReservations(NOW);

    expect(released).toBe(1);
    expect(settleFullReservationMock).toHaveBeenCalledWith('s1');
    expect(settleFullReservationMock).toHaveBeenCalledWith('s2');
  });

  it('settle 全部返回 0（已被别处结算）→ 计数 0', async () => {
    sessionFindManyMock.mockResolvedValueOnce([
      { id: 's1', userId: 'u1', fullReservedMinutes: 4 },
    ]);
    settleFullReservationMock.mockResolvedValue(0);

    expect(await releaseOrphanFullReservations(NOW)).toBe(0);
  });

  it('settle 抛错被 .catch(()=>0) 吞 → 不计数、不影响其余会话', async () => {
    sessionFindManyMock.mockResolvedValueOnce([
      { id: 's1', userId: 'u1', fullReservedMinutes: 4 },
      { id: 's2', userId: 'u2', fullReservedMinutes: 3 },
    ]);
    settleFullReservationMock
      .mockRejectedValueOnce(new Error('db glitch'))
      .mockResolvedValueOnce(3);

    const released = await releaseOrphanFullReservations(NOW);

    // s1 抛错记 0，s2 释放 3 → 计数 1
    expect(released).toBe(1);
  });
});
