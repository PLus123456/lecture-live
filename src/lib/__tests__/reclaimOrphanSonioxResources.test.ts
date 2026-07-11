import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1-17 cleanup outbox 回归：终态会话残留 Soniox 外部 ID 时，兜底重试删除，**先 transcription 再
 * file**，且**只有确认删除(2xx/404)才清对应 ID**。删除未确认 → 保留 ID 待下轮重试（用会话行 ID 当 outbox）。
 */
const {
  sessionFindManyMock,
  sessionUpdateManyMock,
  resolveConfigMock,
  deleteFileMock,
  deleteTranscriptionMock,
} = vi.hoisted(() => ({
  sessionFindManyMock: vi.fn(),
  sessionUpdateManyMock: vi.fn(),
  resolveConfigMock: vi.fn(),
  deleteFileMock: vi.fn(),
  deleteTranscriptionMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { findMany: sessionFindManyMock, updateMany: sessionUpdateManyMock },
  },
}));
vi.mock('@/lib/soniox/env', () => ({
  resolveSonioxConfigForSessionRegion: resolveConfigMock,
}));
vi.mock('@/lib/soniox/asyncFile', () => ({
  deleteSonioxFile: deleteFileMock,
  deleteSonioxTranscription: deleteTranscriptionMock,
  getSonioxTranscription: vi.fn(),
  getSonioxTranscript: vi.fn(),
}));
vi.mock('@/lib/audio/fullTranscribeFinalize', () => ({
  finalizeFullTranscription: vi.fn(),
}));
vi.mock('fs/promises', () => ({ default: { rm: vi.fn(async () => undefined) } }));

import { reclaimOrphanSonioxResources } from '@/lib/billingMaintenance';

const NOW = new Date('2026-07-11T12:00:00.000Z');
const CONFIG = { region: 'eu', restBaseUrl: 'https://x', apiKey: 'k' };

beforeEach(() => {
  vi.clearAllMocks();
  resolveConfigMock.mockResolvedValue(CONFIG);
  sessionUpdateManyMock.mockResolvedValue({ count: 1 });
  deleteFileMock.mockResolvedValue(true);
  deleteTranscriptionMock.mockResolvedValue(true);
});

describe('reclaimOrphanSonioxResources (P1-17)', () => {
  it('确认删除：先 transcription 再 file，清两个 async 外部 ID，计入清理数', async () => {
    sessionFindManyMock
      .mockResolvedValueOnce([
        { id: 's1', sonioxTranscriptionId: 'tx-1', sonioxFileId: 'file-1', sonioxRegion: 'eu' },
      ]) // async
      .mockResolvedValueOnce([]); // full

    const n = await reclaimOrphanSonioxResources(NOW);

    expect(n).toBe(1);
    expect(resolveConfigMock).toHaveBeenCalledWith('eu');
    expect(
      deleteTranscriptionMock.mock.invocationCallOrder[0]
    ).toBeLessThan(deleteFileMock.mock.invocationCallOrder[0]);
    const datas = sessionUpdateManyMock.mock.calls.map((c) => c[0].data);
    expect(datas).toContainEqual({ sonioxTranscriptionId: null });
    expect(datas).toContainEqual({ sonioxFileId: null });
  });

  it('▶ 负向：删除未确认(false) → 不清 ID（保留待下轮重试），不计入清理数', async () => {
    deleteTranscriptionMock.mockResolvedValue(false);
    deleteFileMock.mockResolvedValue(false);
    sessionFindManyMock
      .mockResolvedValueOnce([
        { id: 's1', sonioxTranscriptionId: 'tx-1', sonioxFileId: 'file-1', sonioxRegion: 'eu' },
      ])
      .mockResolvedValueOnce([]);

    const n = await reclaimOrphanSonioxResources(NOW);

    expect(n).toBe(0);
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });

  it('无凭据(config=null) → 跳过，不删不清', async () => {
    resolveConfigMock.mockResolvedValue(null);
    sessionFindManyMock
      .mockResolvedValueOnce([
        { id: 's1', sonioxTranscriptionId: 'tx-1', sonioxFileId: null, sonioxRegion: 'jp' },
      ])
      .mockResolvedValueOnce([]);

    const n = await reclaimOrphanSonioxResources(NOW);

    expect(n).toBe(0);
    expect(deleteTranscriptionMock).not.toHaveBeenCalled();
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });
});
