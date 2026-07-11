import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1-17 回归：取消异步上传时 **先删 transcription 再删 file**，且**只有确认删除(2xx/404)才清 DB 外部 ID**。
 *
 * 旧代码：cancel 在删之前就无条件清空两个外部 ID、且**只删 file 不删 transcription** → transcription
 * 变孤儿、删失败即永久失去重试依据。本测试锁死新顺序与「确认删除才清 ID」。
 */
const {
  sessionUpdateManyMock,
  deleteAsyncUploadMock,
  resolveConfigMock,
  deleteFileMock,
  deleteTranscriptionMock,
} = vi.hoisted(() => ({
  sessionUpdateManyMock: vi.fn(),
  deleteAsyncUploadMock: vi.fn(),
  resolveConfigMock: vi.fn(),
  deleteFileMock: vi.fn(),
  deleteTranscriptionMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { session: { updateMany: sessionUpdateManyMock } },
}));
vi.mock('@/lib/apiResponseCache', () => ({ invalidateSessionsApiCache: vi.fn() }));
vi.mock('@/lib/audio/asyncUploadChunkPersistence', () => ({
  deleteAsyncUpload: deleteAsyncUploadMock,
  loadAsyncUploadManifest: vi.fn(),
  mergeAsyncUploadChunks: vi.fn(),
}));
vi.mock('@/lib/audio/ffmpegTranscode', () => ({
  probeDurationSec: vi.fn(),
  transcodeToMp3: vi.fn(),
  validateMediaContainer: vi.fn(),
}));
vi.mock('@/lib/sessionPersistence', () => ({ persistSessionAudioArtifact: vi.fn() }));
vi.mock('@/lib/soniox/env', () => ({
  resolveAndPersistTaskRegion: vi.fn(),
  resolveSonioxConfigForSessionRegion: resolveConfigMock,
}));
vi.mock('@/lib/soniox/asyncFile', () => ({
  createSonioxTranscription: vi.fn(),
  uploadSonioxFile: vi.fn(),
  deleteSonioxFile: deleteFileMock,
  deleteSonioxTranscription: deleteTranscriptionMock,
}));

import { cancelAsyncUpload } from '@/lib/audio/asyncUploadProcessor';

const CONFIG = { region: 'eu', restBaseUrl: 'https://x', apiKey: 'k' };

beforeEach(() => {
  vi.clearAllMocks();
  sessionUpdateManyMock.mockResolvedValue({ count: 1 });
  deleteAsyncUploadMock.mockResolvedValue(undefined);
  resolveConfigMock.mockResolvedValue(CONFIG);
  deleteFileMock.mockResolvedValue(true);
  deleteTranscriptionMock.mockResolvedValue(true);
});

describe('cancelAsyncUpload (P1-17)', () => {
  it('先删 transcription 再删 file；确认删除后才清对应 DB 外部 ID', async () => {
    await cancelAsyncUpload({
      id: 's1',
      sonioxFileId: 'file-1',
      sonioxTranscriptionId: 'tx-1',
      sonioxRegion: 'eu',
    });

    // 顺序：transcription 先于 file
    expect(deleteTranscriptionMock).toHaveBeenCalledWith(CONFIG, 'tx-1');
    expect(deleteFileMock).toHaveBeenCalledWith(CONFIG, 'file-1');
    expect(
      deleteTranscriptionMock.mock.invocationCallOrder[0]
    ).toBeLessThan(deleteFileMock.mock.invocationCallOrder[0]);

    // P1-16：按 session 固定 region 解析（'eu'），不落回默认。
    expect(resolveConfigMock).toHaveBeenCalledWith('eu');

    // 首个 updateMany 只置 canceled，**不**预清外部 ID。
    const firstData = sessionUpdateManyMock.mock.calls[0][0].data;
    expect(firstData.asyncTranscribeStatus).toBe('canceled');
    expect(firstData).not.toHaveProperty('sonioxFileId');
    expect(firstData).not.toHaveProperty('sonioxTranscriptionId');

    // 确认删除后各自清 ID（后续 updateMany）。
    const clears = sessionUpdateManyMock.mock.calls.slice(1).map((c) => c[0].data);
    expect(clears).toContainEqual({ sonioxTranscriptionId: null });
    expect(clears).toContainEqual({ sonioxFileId: null });
  });

  it('▶ 负向：删 transcription 未确认(false) → 不清 transcription ID（保留待兜底重试）', async () => {
    deleteTranscriptionMock.mockResolvedValue(false);
    deleteFileMock.mockResolvedValue(true);

    await cancelAsyncUpload({
      id: 's1',
      sonioxFileId: 'file-1',
      sonioxTranscriptionId: 'tx-1',
      sonioxRegion: 'eu',
    });

    const clears = sessionUpdateManyMock.mock.calls.slice(1).map((c) => c[0].data);
    // 只清确认删除的 file；未确认的 transcription 不清。
    expect(clears).toContainEqual({ sonioxFileId: null });
    expect(clears).not.toContainEqual({ sonioxTranscriptionId: null });
  });
});
