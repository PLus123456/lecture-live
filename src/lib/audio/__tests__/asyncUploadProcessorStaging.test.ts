import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P0-6r 回归：async 上传管线写录音产物改「stage → CAS → publish/rollback」两阶段。
 *
 * 旧代码在第 4 步直接 persistSessionAudioArtifact 覆盖固定 key `{sessionId}.mp3` 并删旧文件，
 * 无条件跑在 setStatus CAS 之前/之外。窄窗口：async 上传合法地在 RECORDING/PAUSED 启动，
 * transcode 期间会话被 /finalize 独立收尾到 COMPLETED（写入自己的 recordingPath），随后本管线
 * 的写盘覆盖/删掉那份已定稿录音（数据损坏）。
 *
 * 本测试锁死：发布 CAS（updateMany count===0，模拟已 COMPLETED）失败时 →
 *   ① rollbackStagedArtifact 删版本化临时对象；
 *   ② finalizeStagedArtifactPublish（唯一会删 previousReference 旧录音的路径）**绝不**被调用；
 *   ③ 发布 CAS 的 where 带 session.status NOT IN COMPLETED/ARCHIVED 闸；
 *   ④ 管线在此 halt，不再上传 Soniox。
 */
const {
  sessionFindUniqueMock,
  sessionUpdateManyMock,
  deleteAsyncUploadMock,
  loadManifestMock,
  mergeChunksMock,
  probeDurationMock,
  transcodeMock,
  validateContainerMock,
  stageAudioMock,
  finalizePublishMock,
  rollbackStagedMock,
  readFileMock,
  uploadSonioxFileMock,
  resolveRegionMock,
} = vi.hoisted(() => ({
  sessionFindUniqueMock: vi.fn(),
  sessionUpdateManyMock: vi.fn(),
  deleteAsyncUploadMock: vi.fn(),
  loadManifestMock: vi.fn(),
  mergeChunksMock: vi.fn(),
  probeDurationMock: vi.fn(),
  transcodeMock: vi.fn(),
  validateContainerMock: vi.fn(),
  stageAudioMock: vi.fn(),
  finalizePublishMock: vi.fn(),
  rollbackStagedMock: vi.fn(),
  readFileMock: vi.fn(),
  uploadSonioxFileMock: vi.fn(),
  resolveRegionMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findUnique: sessionFindUniqueMock,
      updateMany: sessionUpdateManyMock,
    },
  },
}));
vi.mock('@/lib/apiResponseCache', () => ({ invalidateSessionsApiCache: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('fs/promises', () => ({ default: { readFile: readFileMock } }));
vi.mock('@/lib/audio/asyncUploadChunkPersistence', () => ({
  deleteAsyncUpload: deleteAsyncUploadMock,
  loadAsyncUploadManifest: loadManifestMock,
  mergeAsyncUploadChunks: mergeChunksMock,
}));
vi.mock('@/lib/audio/ffmpegTranscode', () => ({
  probeDurationSec: probeDurationMock,
  transcodeToMp3: transcodeMock,
  validateMediaContainer: validateContainerMock,
}));
vi.mock('@/lib/sessionPersistence', () => ({
  stageSessionAudioArtifact: stageAudioMock,
  finalizeStagedArtifactPublish: finalizePublishMock,
  rollbackStagedArtifact: rollbackStagedMock,
}));
vi.mock('@/lib/soniox/env', () => ({
  resolveAndPersistTaskRegion: resolveRegionMock,
  resolveSonioxConfigForSessionRegion: vi.fn(),
}));
vi.mock('@/lib/soniox/asyncFile', () => ({
  createSonioxTranscription: vi.fn(() => Promise.resolve({ id: 'tx-1' })),
  uploadSonioxFile: uploadSonioxFileMock,
  deleteSonioxFile: vi.fn(() => Promise.resolve(true)),
  deleteSonioxTranscription: vi.fn(() => Promise.resolve(true)),
}));

import { processAsyncUpload } from '@/lib/audio/asyncUploadProcessor';

const EXISTING_RECORDING = 'recordings/s1-finalized.mp3';
const STAGED_TEMP = 'recordings/s1-abc123.mp3';

const STAGED = {
  category: 'recordings' as const,
  reference: STAGED_TEMP,
  localReference: STAGED_TEMP,
  storage: 'local' as const,
  previousReference: EXISTING_RECORDING,
};

beforeEach(() => {
  vi.clearAllMocks();
  // 管线启动时的会话快照：合法地处于 RECORDING（通过 init 终态门禁）。
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
  loadManifestMock.mockResolvedValue({ receivedSeqs: [0, 1], totalChunks: 2 });
  mergeChunksMock.mockResolvedValue({
    filePath: '/tmp/uploads/s1/merged.webm',
    manifest: { mimeType: 'audio/webm' },
    sha256: 'x',
    totalBytes: 100,
  });
  validateContainerMock.mockResolvedValue(undefined);
  probeDurationMock.mockResolvedValue(120); // 秒，< 300min
  transcodeMock.mockResolvedValue(undefined);
  readFileMock.mockResolvedValue(Buffer.from('mp3-bytes'));
  stageAudioMock.mockResolvedValue(STAGED);
  finalizePublishMock.mockResolvedValue({ path: STAGED_TEMP, storage: 'local' });
  rollbackStagedMock.mockResolvedValue(undefined);
  uploadSonioxFileMock.mockResolvedValue({ id: 'file-1' });
  resolveRegionMock.mockResolvedValue({ region: 'eu', restBaseUrl: 'https://x', apiKey: 'k' });
});

describe('processAsyncUpload 录音产物 stage→CAS→publish (P0-6r)', () => {
  it('▶ 负向：transcode 与 publish 之间会话被 finalize 到 COMPLETED（发布 CAS count 0）→ 回滚临时对象、不删已定稿录音、halt', async () => {
    // 第 1 次 setStatus('transcoding') 通过；第 2 次（发布 recordingPath）CAS 未命中（会话已 COMPLETED）。
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(processAsyncUpload({ sessionId: 's1' })).resolves.toBeUndefined();

    // ① 版本化临时对象被回滚（只删 staged，绝不动旧录音）。
    expect(rollbackStagedMock).toHaveBeenCalledTimes(1);
    expect(rollbackStagedMock).toHaveBeenCalledWith(expect.anything(), STAGED);

    // ② 发布（唯一会删 previousReference=已定稿录音的路径）绝不被调用 → 旧录音不被删/覆盖。
    expect(finalizePublishMock).not.toHaveBeenCalled();

    // ③ 发布 CAS 的 where 必须带 session.status 终态闸（否则拦不住独立 finalize 竞态）。
    const publishCall = sessionUpdateManyMock.mock.calls.find(
      (c) => c[0]?.data && 'recordingPath' in c[0].data
    );
    expect(publishCall).toBeTruthy();
    expect(publishCall![0].data.recordingPath).toBe(STAGED_TEMP);
    expect(publishCall![0].where.status).toEqual({
      notIn: ['COMPLETED', 'ARCHIVED'],
    });
    expect(publishCall![0].where.asyncTranscribeStatus).toEqual({
      notIn: ['canceled', 'failed', 'completed'],
    });

    // ④ 管线 halt：未继续上传 Soniox。
    expect(uploadSonioxFileMock).not.toHaveBeenCalled();
  });

  it('▶ 正向：会话仍活跃（发布 CAS count 1）→ 发布并删旧引用、不回滚', async () => {
    // transcoding→count1；发布 recordingPath→count1；再往后的 uploading_to_soniox+fileId CAS
    // 置 count0，让管线在上传 Soniox 后尽早 halt 收束（避免打真实网络），本例只验证发布路径。
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 }) // transcoding
      .mockResolvedValueOnce({ count: 1 }) // 发布 recordingPath
      .mockResolvedValue({ count: 0 }); // 后续步骤 halt

    await expect(processAsyncUpload({ sessionId: 's1' })).resolves.toBeUndefined();

    // 发布被调用（删旧 previousReference），未回滚 staged。
    expect(finalizePublishMock).toHaveBeenCalledTimes(1);
    expect(finalizePublishMock).toHaveBeenCalledWith(expect.anything(), STAGED);
    expect(rollbackStagedMock).not.toHaveBeenCalled();
  });
});
