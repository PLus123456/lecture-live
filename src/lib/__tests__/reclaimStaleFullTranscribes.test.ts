import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C1：reclaimStaleFullTranscribes（cron 兜底回收停滞的完整版补全转录）回归测试。
 *
 * 覆盖 per-session 分支：
 *  - transcribing + Soniox completed → 复用 finalizeFullTranscription 收尾（收尾扣费由 finalize
 *    自身的两道原子 claim 保证恰好一次，见 fullTranscribeFinalize.test.ts）；
 *  - transcribing + finalize 返回 claim_lost（前端 poll 抢先）→ 不重复处理、不标 failed（不双扣）；
 *  - transcribing + Soniox 仍 processing → bump fullTranscribeStartedAt，不标 failed；
 *  - transcribing + Soniox error → 标 failed + 清 Soniox 资源；
 *  - pending / transcoding 僵尸 → 标 failed（不 poll Soniox）；
 *  - finalizing 僵尸 → 回退 transcribing 供重试。
 */

const {
  sessionFindManyMock,
  sessionUpdateManyMock,
  finalizeMock,
  getSonioxTranscriptionMock,
  deleteFileMock,
  deleteTranscriptionMock,
  resolveSonioxMock,
} = vi.hoisted(() => ({
  sessionFindManyMock: vi.fn(),
  sessionUpdateManyMock: vi.fn(),
  finalizeMock: vi.fn(),
  getSonioxTranscriptionMock: vi.fn(),
  deleteFileMock: vi.fn(),
  deleteTranscriptionMock: vi.fn(),
  resolveSonioxMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { findMany: sessionFindManyMock, updateMany: sessionUpdateManyMock },
  },
}));
vi.mock('@/lib/audio/fullTranscribeFinalize', () => ({
  finalizeFullTranscription: finalizeMock,
}));
vi.mock('@/lib/soniox/asyncFile', () => ({
  getSonioxTranscription: getSonioxTranscriptionMock,
  deleteSonioxFile: deleteFileMock,
  deleteSonioxTranscription: deleteTranscriptionMock,
  // asyncTranscribeFinalize（billingMaintenance 的另一 importer）在 import 期取此绑定，桩占位
  getSonioxTranscript: vi.fn(),
}));
vi.mock('@/lib/soniox/env', () => ({
  resolveSonioxRuntimeConfigAsync: resolveSonioxMock,
}));
vi.mock('fs/promises', () => ({
  default: { rm: vi.fn(async () => undefined) },
}));

import { reclaimStaleFullTranscribes } from '@/lib/billingMaintenance';

const NOW = new Date('2026-07-10T12:00:00.000Z');
const SONIOX = { restBaseUrl: 'https://x', apiKey: 'k' };

function candidate(overrides: Record<string, unknown>) {
  return {
    id: 's1',
    userId: 'u1',
    fullTranscribeStatus: 'transcribing',
    fullSonioxFileId: 'f1',
    fullSonioxTranscriptionId: 't1',
    targetLang: 'zh',
    durationMs: 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveSonioxMock.mockResolvedValue(SONIOX);
  sessionUpdateManyMock.mockResolvedValue({ count: 1 });
  deleteFileMock.mockResolvedValue(undefined);
  deleteTranscriptionMock.mockResolvedValue(undefined);
});

describe('reclaimStaleFullTranscribes', () => {
  it('transcribing + Soniox completed → 调 finalizeFullTranscription 收尾，计入回收数', async () => {
    sessionFindManyMock.mockResolvedValue([candidate({})]);
    getSonioxTranscriptionMock.mockResolvedValue({ status: 'completed' });
    finalizeMock.mockResolvedValue({
      outcome: 'completed',
      fullTranscriptPath: 'local:full-transcripts/s1.json',
      segmentCount: 2,
    });

    const n = await reclaimStaleFullTranscribes(NOW);

    expect(n).toBe(1);
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    // allowClaimFrom 含 transcribing + finalizing（回收兜底复收 finalizing 僵尸）
    expect(finalizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', userId: 'u1' }),
      SONIOX,
      { allowClaimFrom: ['transcribing', 'finalizing'] }
    );
    // 收尾走 finalize 自己的 updateMany（此处被 mock），reclaim 不再另标 failed
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });

  it('finalize 返回 claim_lost（前端 poll 抢先收尾）→ 不重复处理、不标 failed（绝不双扣）', async () => {
    sessionFindManyMock.mockResolvedValue([candidate({})]);
    getSonioxTranscriptionMock.mockResolvedValue({ status: 'completed' });
    finalizeMock.mockResolvedValue({ outcome: 'claim_lost' });

    const n = await reclaimStaleFullTranscribes(NOW);

    expect(n).toBe(0);
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    // 交给对方，reclaim 不标 failed
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });

  it('transcribing + Soniox 仍 processing → bump fullTranscribeStartedAt，不 finalize、不标 failed', async () => {
    sessionFindManyMock.mockResolvedValue([candidate({})]);
    getSonioxTranscriptionMock.mockResolvedValue({ status: 'processing' });

    const n = await reclaimStaleFullTranscribes(NOW);

    expect(n).toBe(0);
    expect(finalizeMock).not.toHaveBeenCalled();
    expect(sessionUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 's1', fullTranscribeStatus: 'transcribing' }),
        data: { fullTranscribeStartedAt: NOW },
      })
    );
  });

  it('transcribing + Soniox error → 标 failed + 清 Soniox file/transcription', async () => {
    sessionFindManyMock.mockResolvedValue([
      candidate({ fullSonioxFileId: 'f4', fullSonioxTranscriptionId: 't4' }),
    ]);
    getSonioxTranscriptionMock.mockResolvedValue({ status: 'error' });

    const n = await reclaimStaleFullTranscribes(NOW);

    expect(n).toBe(1);
    expect(finalizeMock).not.toHaveBeenCalled();
    expect(sessionUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fullTranscribeStatus: 'failed' }),
      })
    );
    expect(deleteFileMock).toHaveBeenCalledWith(SONIOX, 'f4');
    expect(deleteTranscriptionMock).toHaveBeenCalledWith(SONIOX, 't4');
  });

  it('pending 僵尸 → 标 failed，不 poll Soniox', async () => {
    sessionFindManyMock.mockResolvedValue([
      candidate({ id: 's2', fullTranscribeStatus: 'pending', fullSonioxFileId: null, fullSonioxTranscriptionId: null }),
    ]);

    const n = await reclaimStaleFullTranscribes(NOW);

    expect(n).toBe(1);
    expect(getSonioxTranscriptionMock).not.toHaveBeenCalled();
    expect(sessionUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 's2',
          fullTranscribeStatus: { in: ['pending', 'transcoding', 'transcribing', 'finalizing'] },
        }),
        data: expect.objectContaining({ fullTranscribeStatus: 'failed' }),
      })
    );
  });

  it('finalizing 僵尸 + Soniox completed → 经 allowClaimFrom 复收到 completed（不回退 transcribing、不双扣）', async () => {
    sessionFindManyMock.mockResolvedValue([
      candidate({ id: 's3', fullTranscribeStatus: 'finalizing' }),
    ]);
    getSonioxTranscriptionMock.mockResolvedValue({ status: 'completed' });
    finalizeMock.mockResolvedValue({ outcome: 'completed', fullTranscriptPath: 'x', segmentCount: 1 });

    const n = await reclaimStaleFullTranscribes(NOW);

    expect(n).toBe(1);
    expect(finalizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's3' }),
      SONIOX,
      { allowClaimFrom: ['transcribing', 'finalizing'] }
    );
    // 关键：不再有 finalizing→transcribing 的盲目回退写（会与在途 finalize 赛跑）
    const revertCall = sessionUpdateManyMock.mock.calls.find(
      (c) => c[0]?.data?.fullTranscribeStatus === 'transcribing'
    );
    expect(revertCall).toBeUndefined();
  });

  it('Soniox 未配置 → 可 salvage 的 transcribing 会话保守跳过，绝不标 failed（不丢弃可能已完成的转录）', async () => {
    resolveSonioxMock.mockResolvedValue(null);
    sessionFindManyMock.mockResolvedValue([candidate({})]); // transcribing

    const n = await reclaimStaleFullTranscribes(NOW);

    expect(n).toBe(0);
    expect(getSonioxTranscriptionMock).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
    // 绝不标 failed
    const failedCall = sessionUpdateManyMock.mock.calls.find(
      (c) => c[0]?.data?.fullTranscribeStatus === 'failed'
    );
    expect(failedCall).toBeUndefined();
  });

  it('按 fullTranscribeStartedAt 超阈值筛选（transcribing 且 startedAt<=阈值）', async () => {
    sessionFindManyMock.mockResolvedValue([]);
    await reclaimStaleFullTranscribes(NOW);
    expect(sessionFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fullTranscribeStatus: { in: ['pending', 'transcoding', 'transcribing', 'finalizing'] },
          fullTranscribeStartedAt: { lte: expect.any(Date) },
        }),
      })
    );
  });
});
