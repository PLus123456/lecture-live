import { beforeEach, describe, expect, it, vi } from 'vitest';

const readJson = <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const {
  verifyAuthMock,
  sessionFindUniqueMock,
  sessionUpdateManyMock,
  invalidateSessionsApiCacheMock,
  mergeRecordingDraftChunksMock,
  sealRecordingDraftMock,
  unsealRecordingDraftMock,
  deleteRecordingDraftMock,
  stageSessionAudioArtifactMock,
  settleStagedArtifactsInTransactionMock,
  finalizeStagedArtifactPublishMock,
  readbackStagedArtifactPublicationMock,
  rollbackStagedArtifactMock,
  normalizeRecordedAudioDurationMock,
  measureAuthoritativeRecordingDurationMsFromBufferMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  sessionUpdateManyMock: vi.fn(),
  invalidateSessionsApiCacheMock: vi.fn(),
  mergeRecordingDraftChunksMock: vi.fn(),
  sealRecordingDraftMock: vi.fn(),
  unsealRecordingDraftMock: vi.fn(),
  deleteRecordingDraftMock: vi.fn(),
  stageSessionAudioArtifactMock: vi.fn(),
  settleStagedArtifactsInTransactionMock: vi.fn(),
  finalizeStagedArtifactPublishMock: vi.fn(),
  readbackStagedArtifactPublicationMock: vi.fn(),
  rollbackStagedArtifactMock: vi.fn(),
  normalizeRecordedAudioDurationMock: vi.fn(),
  measureAuthoritativeRecordingDurationMsFromBufferMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findUnique: sessionFindUniqueMock,
      updateMany: sessionUpdateManyMock,
    },
    $transaction: vi.fn(async (callback) =>
      callback({ session: { updateMany: sessionUpdateManyMock } })
    ),
  },
}));
vi.mock('@/lib/security', () => ({ assertOwnership: vi.fn() }));
vi.mock('@/lib/apiResponseCache', () => ({
  invalidateSessionsApiCache: invalidateSessionsApiCacheMock,
}));
vi.mock('@/lib/recordingDraftPersistence', () => ({
  mergeRecordingDraftChunks: mergeRecordingDraftChunksMock,
  sealRecordingDraft: sealRecordingDraftMock,
  unsealRecordingDraft: unsealRecordingDraftMock,
  deleteRecordingDraft: deleteRecordingDraftMock,
  MAX_DRAFT_TOTAL_BYTES: 512 * 1024 * 1024,
  RecordingDraftTooLargeError: class RecordingDraftTooLargeError extends Error {},
}));
vi.mock('@/lib/sessionPersistence', () => ({
  stageSessionAudioArtifact: stageSessionAudioArtifactMock,
  settleStagedArtifactsInTransaction: settleStagedArtifactsInTransactionMock,
  completeStagedArtifactPublishes: finalizeStagedArtifactPublishMock,
  readbackStagedArtifactPublication: readbackStagedArtifactPublicationMock,
  rollbackStagedArtifact: rollbackStagedArtifactMock,
}));
vi.mock('@/lib/audio/recordingDuration', () => ({
  MAX_DURATION_FIX_BYTES: 128 * 1024 * 1024,
  normalizeRecordedAudioDuration: normalizeRecordedAudioDurationMock,
  measureAuthoritativeRecordingDurationMsFromBuffer:
    measureAuthoritativeRecordingDurationMsFromBufferMock,
  RECORDING_DURATION_LIMIT_GRACE_MS: 60_000,
  RecordingDurationMeasurementError: class RecordingDurationMeasurementError extends Error {},
}));
vi.mock('@/lib/billing', () => ({
  getMaxSessionDurationMs: () => 4 * 60 * 60_000,
}));

import { POST } from '@/app/api/sessions/[id]/audio/draft/finalize/route';
import { RecordingDurationMeasurementError } from '@/lib/audio/recordingDuration';

const params = Promise.resolve({ id: 'session-1' });
const req = (url = 'http://localhost:3000/api/sessions/session-1/audio/draft/finalize') =>
  new Request(url, { method: 'POST' });

describe('audio/draft/finalize route (P0-5 / P1-7)', () => {
  beforeEach(() => {
    verifyAuthMock.mockReset().mockResolvedValue({ id: 'user-1', role: 'PRO' });
    sessionFindUniqueMock.mockReset().mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      status: 'FINALIZING',
      recordingPath: null,
    });
    sessionUpdateManyMock.mockReset().mockResolvedValue({ count: 1 });
    invalidateSessionsApiCacheMock.mockReset().mockResolvedValue(undefined);
    sealRecordingDraftMock
      .mockReset()
      .mockResolvedValue({ maxSeq: 2, nextSeq: 3, revision: 123, sealed: true });
    unsealRecordingDraftMock.mockReset().mockResolvedValue(undefined);
    deleteRecordingDraftMock.mockReset().mockResolvedValue(undefined);
    stageSessionAudioArtifactMock
      .mockReset()
      .mockResolvedValue({ reference: 'local:recordings/sess-1-x.webm', localReference: 'local:recordings/sess-1-x.webm', storage: 'local', category: 'recordings' });
    settleStagedArtifactsInTransactionMock
      .mockReset()
      .mockResolvedValue([{ staged: {}, settled: {} }]);
    finalizeStagedArtifactPublishMock
      .mockReset()
      .mockResolvedValue([{ path: 'local:recordings/sess-1-x.webm', storage: 'local' }]);
    readbackStagedArtifactPublicationMock
      .mockReset()
      .mockResolvedValue({ outcome: 'not_committed', publications: [] });
    rollbackStagedArtifactMock.mockReset().mockResolvedValue(undefined);
    normalizeRecordedAudioDurationMock.mockReset().mockImplementation(async ({ buffer }) => buffer);
    measureAuthoritativeRecordingDurationMsFromBufferMock
      .mockReset()
      .mockResolvedValue(120_000);
    mergeRecordingDraftChunksMock.mockReset();
  });

  it('P0-5：草稿有缺口(hasGap) → 409、保留草稿、绝不置终态', async () => {
    mergeRecordingDraftChunksMock.mockResolvedValue({
      buffer: Buffer.from('partial'),
      manifest: { mimeType: 'audio/webm', receivedSeqs: [0, 1, 3] },
      hasGap: true,
    });

    const response = await POST(req(), { params });

    expect(response.status).toBe(409);
    await expect(readJson<Record<string, unknown>>(response)).resolves.toMatchObject({
      hasGap: true,
    });
    // 关键：不删草稿、不写库（不置 COMPLETED）——旧代码会静默用残缺前缀定稿并删草稿。
    expect(deleteRecordingDraftMock).not.toHaveBeenCalled();
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
    // seal 仍在缺口检查之前执行（阻断迟到写）。
    expect(sealRecordingDraftMock).toHaveBeenCalledTimes(1);
    // 缺片未提交 → 释放封存，客户端可补传缺片后重试（避免 seal 死锁）。
    expect(unsealRecordingDraftMock).toHaveBeenCalledTimes(1);
  });

  it('P1-7：?phase=seal 只封存并返回清单，不合并/不定稿', async () => {
    const response = await POST(
      req('http://localhost:3000/api/sessions/session-1/audio/draft/finalize?phase=seal'),
      { params }
    );

    expect(response.status).toBe(200);
    await expect(readJson<Record<string, unknown>>(response)).resolves.toMatchObject({
      sealed: true,
      nextSeq: 3,
    });
    expect(mergeRecordingDraftChunksMock).not.toHaveBeenCalled();
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });

  it('完整草稿(hasGap=false) → stage+CAS+publish 定稿并删草稿', async () => {
    mergeRecordingDraftChunksMock.mockResolvedValue({
      buffer: Buffer.from('complete'),
      manifest: { mimeType: 'audio/webm', receivedSeqs: [0, 1, 2] },
      hasGap: false,
    });

    const response = await POST(req(), { params });

    expect(response.status).toBe(200);
    expect(sessionUpdateManyMock).toHaveBeenCalledTimes(1);
    // CAS where 带终态守卫。
    expect(sessionUpdateManyMock.mock.calls[0][0].where.status).toEqual({
      notIn: ['COMPLETED', 'ARCHIVED'],
    });
    expect(finalizeStagedArtifactPublishMock).toHaveBeenCalledTimes(1);
    expect(deleteRecordingDraftMock).toHaveBeenCalledTimes(1);
    expect(rollbackStagedArtifactMock).not.toHaveBeenCalled();
  });

  it('CAS 落空(count=0：会话已终态) → 回滚临时对象、409、不删草稿', async () => {
    mergeRecordingDraftChunksMock.mockResolvedValue({
      buffer: Buffer.from('complete'),
      manifest: { mimeType: 'audio/webm', receivedSeqs: [0, 1, 2] },
      hasGap: false,
    });
    sessionUpdateManyMock.mockResolvedValue({ count: 0 });

    const response = await POST(req(), { params });

    expect(response.status).toBe(409);
    expect(rollbackStagedArtifactMock).toHaveBeenCalledTimes(1);
    expect(finalizeStagedArtifactPublishMock).not.toHaveBeenCalled();
    expect(deleteRecordingDraftMock).not.toHaveBeenCalled();
  });

  /**
   * session-persist#143：草稿定稿对 CREATED 会话不做 ffprobe 兜底 → 落库 durationMs=0 的永久
   * 录音，进而白嫖完整版转录。
   *
   * 攻击路径：建会话（CREATED）→ 灌满草稿分片（≤512MiB，chunks 路由对分片内容零校验）→ 把
   * CREATED→RECORDING→FINALIZING 一气呵成（serverStartedAt 与 serverPausedAt 相隔毫秒，
   * FINALIZING 会把 serverPausedAt 置为 now，于是 serverDuration 冻结在 ≈0）→ 定稿：
   * resolveExpectedRecordingDurationMs 的三个来源同时为 0，durationMs 不写、recordingPath 照常
   * 发布 → /full-transcribe 的 estimatedMinutes=0 跳过预留，fullTranscribeFinalize 的实扣也是
   * ceil(getBillableMinutes(0)×倍率)=0 → 整段 Soniox 转录全程零扣费。
   *
   * 事后也没有任何兜底会补收：Soniox usage-logs 对账只覆盖 mint 过 grant 的直连串流
   *（client_reference_id = 'rt|it:userId:grantId'），异步文件转录不在其中。
   */
  it('SEC-018：小正时长不能跳过媒体实测，真实时长落库', async () => {
    mergeRecordingDraftChunksMock.mockResolvedValue({
      buffer: Buffer.from('a-very-long-recording'),
      manifest: { mimeType: 'audio/webm', receivedSeqs: [0, 1, 2] },
      hasGap: false,
    });
    sessionFindUniqueMock.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      status: 'FINALIZING',
      recordingPath: null,
      durationMs: 1,
    });
    measureAuthoritativeRecordingDurationMsFromBufferMock.mockResolvedValue(
      95 * 60_000
    );

    const response = await POST(req(), { params });

    expect(response.status).toBe(200);
    expect(measureAuthoritativeRecordingDurationMsFromBufferMock).toHaveBeenCalledTimes(1);
    expect(sessionUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ durationMs: 95 * 60_000 }),
      })
    );
  });

  it('SEC-018：权威测量失败 → 不发布、不删草稿并解除 seal 供重试', async () => {
    mergeRecordingDraftChunksMock.mockResolvedValue({
      buffer: Buffer.from('unreadable'),
      manifest: { mimeType: 'audio/webm', receivedSeqs: [0] },
      hasGap: false,
    });
    measureAuthoritativeRecordingDurationMsFromBufferMock.mockRejectedValue(
      new RecordingDurationMeasurementError()
    );

    const response = await POST(req(), { params });

    expect(response.status).toBe(422);
    expect(stageSessionAudioArtifactMock).not.toHaveBeenCalled();
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
    expect(finalizeStagedArtifactPublishMock).not.toHaveBeenCalled();
    expect(deleteRecordingDraftMock).not.toHaveBeenCalled();
    expect(unsealRecordingDraftMock).toHaveBeenCalledTimes(1);
  });

  it('已有正时长仍必须重新测量将发布的媒体', async () => {
    mergeRecordingDraftChunksMock.mockResolvedValue({
      buffer: Buffer.from('complete'),
      manifest: { mimeType: 'audio/webm', receivedSeqs: [0, 1, 2] },
      hasGap: false,
    });

    await POST(req(), { params });

    expect(measureAuthoritativeRecordingDurationMsFromBufferMock).toHaveBeenCalledTimes(1);
  });
});
