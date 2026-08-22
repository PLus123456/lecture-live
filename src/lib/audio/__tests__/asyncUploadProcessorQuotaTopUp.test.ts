import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1-3 回归：谎报 MIME 把异步上传预留压到真实时长的 1/50，且月月复发。
 *
 * 入口 init 的预留额只能靠客户端声明的时长/MIME 估算：300 分钟 12kbps opus（≈27MB）声明成
 * `video/mp4` → floor = ceil(27/5) = 6 分钟预留 vs 300 分钟实转。finalize 虽按 ffprobe 足额实扣，
 * 但非持池用户的月度重置无条件把 transcriptionMinutesUsed 归零 → 超用**每月可重复**。
 *
 * 本测试锁死：转码后 probe 到真实时长时（**上传 Soniox 之前**）按真值回补预留差额；
 *   ① 差额补得上 → 回写 asyncReservedMinutes（用 increment，不能用「旧值+差额」赋值）后继续管线；
 *   ② 差额补不上（额度不足）→ 管线失败、**绝不上传 Soniox**，并 inline 释放已持有的预留。
 */
const {
  sessionFindUniqueMock,
  sessionUpdateManyMock,
  txQueryRawMock,
  txSessionUpdateMock,
  reserveMock,
  settleAsyncMock,
  probeDurationMock,
  uploadSonioxFileMock,
  deleteAsyncUploadMock,
} = vi.hoisted(() => ({
  sessionFindUniqueMock: vi.fn(),
  sessionUpdateManyMock: vi.fn(),
  txQueryRawMock: vi.fn(),
  txSessionUpdateMock: vi.fn(),
  reserveMock: vi.fn(),
  settleAsyncMock: vi.fn(),
  probeDurationMock: vi.fn(),
  uploadSonioxFileMock: vi.fn(),
  deleteAsyncUploadMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findUnique: sessionFindUniqueMock,
      updateMany: sessionUpdateManyMock,
    },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        $queryRaw: (...a: unknown[]) => txQueryRawMock(...a),
        session: {
          update: (...a: unknown[]) => txSessionUpdateMock(...a),
          updateMany: (...a: unknown[]) => sessionUpdateManyMock(...a),
        },
      }),
  },
}));
vi.mock('@/lib/quota', () => ({
  reserveTranscriptionMinutes: reserveMock,
  settleAsyncReservation: settleAsyncMock,
}));
vi.mock('@/lib/apiResponseCache', () => ({ invalidateSessionsApiCache: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('fs/promises', () => ({
  default: { readFile: vi.fn(() => Promise.resolve(Buffer.from('mp3'))) },
}));
vi.mock('@/lib/audio/asyncUploadChunkPersistence', () => ({
  deleteAsyncUpload: deleteAsyncUploadMock,
  loadAsyncUploadManifest: vi.fn(() =>
    Promise.resolve({ receivedSeqs: [0], totalChunks: 1 })
  ),
  mergeAsyncUploadChunks: vi.fn(() =>
    Promise.resolve({ filePath: '/tmp/u/s1/merged.webm' })
  ),
}));
vi.mock('@/lib/audio/ffmpegTranscode', () => ({
  probeDurationSec: probeDurationMock,
  transcodeToMp3: vi.fn(() => Promise.resolve(undefined)),
  validateMediaContainer: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('@/lib/sessionPersistence', () => ({
  stageSessionAudioArtifact: vi.fn(() =>
    Promise.resolve({
      category: 'recordings',
      reference: 'recordings/s1-tmp.mp3',
      localReference: 'recordings/s1-tmp.mp3',
      storage: 'local',
      previousReference: null,
      storedArtifactId: 'artifact-1',
      expectedPreviousArtifactId: null,
      actualBytes: 3,
      artifactType: 'recording',
    })
  ),
  settleStagedArtifactsInTransaction: vi.fn((_tx, staged) =>
    Promise.resolve(
      staged.map((entry: unknown) => ({
        staged: entry,
        settled: { artifact: { id: 'artifact-1' }, previous: null },
      }))
    )
  ),
  completeStagedArtifactPublishes: vi.fn(() => Promise.resolve([])),
  rollbackStagedArtifact: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  STORED_ARTIFACT_STATE: { ACTIVE: 'ACTIVE', RESERVED: 'RESERVED' },
  getStoredArtifactById: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('@/lib/soniox/env', () => ({
  resolveAndPersistTaskRegion: vi.fn(() =>
    Promise.resolve({ region: 'eu', restBaseUrl: 'https://x', apiKey: 'k' })
  ),
  resolveSonioxConfigForSessionRegion: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('@/lib/soniox/asyncFile', () => ({
  createSonioxTranscription: vi.fn(() => Promise.resolve({ id: 'tx-1' })),
  uploadSonioxFile: uploadSonioxFileMock,
  deleteSonioxFile: vi.fn(() => Promise.resolve(true)),
  deleteSonioxTranscription: vi.fn(() => Promise.resolve(true)),
}));

// getBillableMinutes 用真实实现锁死口径（ceil(ms/60000)）
import { processAsyncUpload } from '@/lib/audio/asyncUploadProcessor';

beforeEach(() => {
  vi.clearAllMocks();
  sessionFindUniqueMock.mockResolvedValue({
    id: 's1',
    userId: 'u1',
    status: 'RECORDING',
    recordingPath: null,
    sourceLang: 'en',
    targetLang: null,
    sonioxRegion: 'eu',
    sonioxFileId: null,
  });
  deleteAsyncUploadMock.mockResolvedValue(undefined);
  // 真实时长 300 分钟（谎报 video/mp4 的 27MB opus，入口只预留了 6 分钟）
  probeDurationMock.mockResolvedValue(300 * 60);
  txQueryRawMock.mockResolvedValue([{ asyncReservedMinutes: 6 }]);
  txSessionUpdateMock.mockResolvedValue(undefined);
  reserveMock.mockResolvedValue(true);
  settleAsyncMock.mockResolvedValue(6);
  uploadSonioxFileMock.mockResolvedValue({ id: 'file-1' });
  // transcoding CAS → 1；发布 recordingPath CAS → 1；之后统一 0 让管线尽早 halt。
  sessionUpdateManyMock
    .mockResolvedValueOnce({ count: 1 })
    .mockResolvedValueOnce({ count: 1 })
    .mockResolvedValue({ count: 0 });
});

describe('processAsyncUpload 实测时长回补预留 (P1-3)', () => {
  it('▶ 差额补得上：按真实 300 分钟回补 294 分钟（increment，非赋值），随后才上传 Soniox', async () => {
    await expect(processAsyncUpload({ sessionId: 's1' })).resolves.toBeUndefined();

    // 300（真实） − 6（入口预留） = 294
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(reserveMock).toHaveBeenCalledWith('u1', 294, expect.anything());
    // 必须 increment：reserve 内部 ensureQuotaWindow 可能刚触发月度重置清零本列，
    // 「旧值+差额」赋值会凭空复活一笔 used 里并不存在的预留。
    expect(txSessionUpdateMock).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { asyncReservedMinutes: { increment: 294 } },
    });
    // 回补在上传 Soniox 之前完成
    expect(uploadSonioxFileMock).toHaveBeenCalledTimes(1);
    expect(reserveMock.mock.invocationCallOrder[0]).toBeLessThan(
      uploadSonioxFileMock.mock.invocationCallOrder[0]
    );
  });

  it('▶ 负向（核心）：额度不足补不上差额 → 管线失败、**绝不上传 Soniox**，并 inline 释放预留', async () => {
    reserveMock.mockResolvedValue(false);
    // 本例在上传 Soniox 之前就失败，后续 CAS 只有「标 failed」这一次，让它抢到终态（count 1）。
    sessionUpdateManyMock.mockReset().mockResolvedValue({ count: 1 });

    await expect(processAsyncUpload({ sessionId: 's1' })).rejects.toThrow(
      /Transcription quota exceeded/
    );

    // 关键：没有把 300 分钟的转录送进 Soniox（否则就是白嫖成功、finalize 只能事后记账）
    expect(uploadSonioxFileMock).not.toHaveBeenCalled();
    // 标 failed 后 inline 释放入口预留，不干等 cron 的 30 分钟陈旧门槛
    const failedCall = sessionUpdateManyMock.mock.calls.find(
      (c) => c[0]?.data?.asyncTranscribeStatus === 'failed'
    );
    expect(failedCall).toBeTruthy();
    expect(settleAsyncMock).toHaveBeenCalledWith('s1');
  });

  it('入口预留已足额（>= 实测）→ 不重复 reserve、不改预留列', async () => {
    txQueryRawMock.mockResolvedValue([{ asyncReservedMinutes: 400 }]);

    await expect(processAsyncUpload({ sessionId: 's1' })).resolves.toBeUndefined();

    expect(reserveMock).not.toHaveBeenCalled();
    expect(txSessionUpdateMock).not.toHaveBeenCalled();
    expect(uploadSonioxFileMock).toHaveBeenCalledTimes(1);
  });
});
