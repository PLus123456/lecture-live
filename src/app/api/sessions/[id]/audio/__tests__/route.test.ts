import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P5-14：直传录音入口的两套存储会计。
 *  - 字节侧：此前完全不入 storage_bytes（只过了 storage_hours 的读时闸），
 *    32MB × 20 次/小时/用户 的字节量对字节配额完全隐形。
 *  - 时长侧：durationMs 的三个来源都建立在「走过实时链路」的前提上；
 *    从没连过 WS 的会话直传音频时三者同时为 0 → 对 storage_hours 的贡献恒为 0。
 */

const {
  verifyAuthMock,
  enforceRateLimitMock,
  sessionFindUniqueMock,
  sessionUpdateManyMock,
  checkQuotaMock,
  reserveStorageBytesMock,
  releaseStorageBytesMock,
  measureAuthoritativeRecordingDurationMsFromBufferMock,
  normalizeRecordedAudioDurationMock,
  stageSessionAudioArtifactMock,
  settleStagedArtifactsInTransactionMock,
  finalizeStagedArtifactPublishMock,
  readbackStagedArtifactPublicationMock,
  rollbackStagedArtifactMock,
  resolveSessionAudioLocationMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  sessionUpdateManyMock: vi.fn(),
  checkQuotaMock: vi.fn(),
  reserveStorageBytesMock: vi.fn(),
  releaseStorageBytesMock: vi.fn(),
  measureAuthoritativeRecordingDurationMsFromBufferMock: vi.fn(),
  normalizeRecordedAudioDurationMock: vi.fn(),
  stageSessionAudioArtifactMock: vi.fn(),
  settleStagedArtifactsInTransactionMock: vi.fn(),
  finalizeStagedArtifactPublishMock: vi.fn(),
  readbackStagedArtifactPublicationMock: vi.fn(),
  rollbackStagedArtifactMock: vi.fn(),
  resolveSessionAudioLocationMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { findUnique: sessionFindUniqueMock, updateMany: sessionUpdateManyMock },
    $transaction: vi.fn(async (callback) =>
      callback({ session: { updateMany: sessionUpdateManyMock } })
    ),
  },
}));
vi.mock('@/lib/apiResponseCache', () => ({
  invalidateSessionsApiCache: vi.fn(),
}));
vi.mock('@/lib/security', () => ({
  assertOwnership: vi.fn(),
  assertSessionReadAccess: vi.fn(() => ({ isCrossUserAdmin: false })),
}));
vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));
vi.mock('@/lib/audio/uploadValidation', () => ({
  isAllowedAudioMimeType: () => true,
  matchesAudioSignature: () => true,
  MAX_AUDIO_UPLOAD_BYTES: 32 * 1024 * 1024,
  normalizeAudioMimeType: (t: string) => t,
}));
vi.mock('@/lib/recordingDraftPersistence', () => ({
  deleteRecordingDraft: vi.fn(async () => undefined),
}));
vi.mock('@/lib/sessionPersistence', () => ({
  stageSessionAudioArtifact: stageSessionAudioArtifactMock,
  settleStagedArtifactsInTransaction: settleStagedArtifactsInTransactionMock,
  completeStagedArtifactPublishes: finalizeStagedArtifactPublishMock,
  readbackStagedArtifactPublication: readbackStagedArtifactPublicationMock,
  rollbackStagedArtifact: rollbackStagedArtifactMock,
  loadSessionAudioArtifact: vi.fn(),
  resolveSessionAudioLocation: resolveSessionAudioLocationMock,
  openLocalAudioRangeStream: vi.fn(),
}));
vi.mock('@/lib/storage/cloudreve', () => ({ CloudreveStorage: { create: vi.fn() } }));
vi.mock('@/lib/audio/recordingDuration', () => ({
  normalizeRecordedAudioDuration: normalizeRecordedAudioDurationMock,
  measureAuthoritativeRecordingDurationMsFromBuffer:
    measureAuthoritativeRecordingDurationMsFromBufferMock,
  RECORDING_DURATION_LIMIT_GRACE_MS: 60_000,
  RecordingDurationMeasurementError: class RecordingDurationMeasurementError extends Error {},
}));
vi.mock('@/lib/billing', () => ({
  getMaxSessionDurationMs: () => 4 * 60 * 60_000,
}));
vi.mock('@/lib/quota', () => ({
  checkQuota: checkQuotaMock,
  reserveStorageBytes: reserveStorageBytesMock,
  releaseStorageBytes: releaseStorageBytesMock,
}));
vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  StoredArtifactQuotaExceededError: class StoredArtifactQuotaExceededError extends Error {},
}));

import { POST } from '@/app/api/sessions/[id]/audio/route';
import { RecordingDurationMeasurementError } from '@/lib/audio/recordingDuration';
import { StoredArtifactQuotaExceededError } from '@/lib/storage/storedArtifactLedger';

const AUDIO_BYTES = 1024;

function makeReq() {
  const form = new FormData();
  form.set(
    'file',
    new File([new Uint8Array(AUDIO_BYTES)], 'rec.webm', { type: 'audio/webm' })
  );
  return new Request('http://localhost:3000/api/sessions/s1/audio', {
    method: 'POST',
    body: form,
  });
}

const params = Promise.resolve({ id: 's1' });

describe('POST /api/sessions/[id]/audio 存储会计 (P5-14)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'u1', role: 'PRO' });
    enforceRateLimitMock.mockResolvedValue(null);
    sessionFindUniqueMock.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      status: 'RECORDING',
      durationMs: 0,
      recordingPath: null,
    });
    sessionUpdateManyMock.mockResolvedValue({ count: 1 });
    checkQuotaMock.mockResolvedValue(true);
    reserveStorageBytesMock.mockResolvedValue(true);
    releaseStorageBytesMock.mockResolvedValue(null);
    measureAuthoritativeRecordingDurationMsFromBufferMock.mockResolvedValue(120_000);
    normalizeRecordedAudioDurationMock.mockImplementation(
      async (o: { buffer: Buffer }) => o.buffer
    );
    resolveSessionAudioLocationMock.mockResolvedValue(null);
    stageSessionAudioArtifactMock.mockResolvedValue({
      reference: 'local:recordings/s1.webm',
      previousReference: null,
    });
    settleStagedArtifactsInTransactionMock.mockResolvedValue([
      { staged: {}, settled: {} },
    ]);
    finalizeStagedArtifactPublishMock.mockResolvedValue([
      { path: 'local:recordings/s1.webm', storage: 'local' },
    ]);
    readbackStagedArtifactPublicationMock.mockResolvedValue({
      outcome: 'not_committed',
      publications: [],
    });
  });

  it('首次上传 → stage 统一账本在物理写入前预留字节', async () => {
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(stageSessionAudioArtifactMock).toHaveBeenCalledTimes(1);
    expect(reserveStorageBytesMock).not.toHaveBeenCalled();
  });

  it('统一账本预留报配额不足 → 402，且绝不落库', async () => {
    stageSessionAudioArtifactMock.mockRejectedValue(
      new StoredArtifactQuotaExceededError()
    );

    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(402);
    expect((await res.json()).quota).toBe('storage_bytes');
    expect(stageSessionAudioArtifactMock).toHaveBeenCalledTimes(1);
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });

  it('终态会话 CAS 失败 → rollback staged 对象原子释放账本预留', async () => {
    sessionUpdateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(409);
    expect(rollbackStagedArtifactMock).toHaveBeenCalled();
    expect(releaseStorageBytesMock).not.toHaveBeenCalled();
  });

  it('覆盖旧录音 → 新对象按完整临时占用预留，不用不安全净增量', async () => {
    resolveSessionAudioLocationMock.mockResolvedValue({
      kind: 'local',
      filePath: '/tmp/x',
      size: 400,
      contentType: 'audio/webm',
    });

    await POST(makeReq(), { params });

    expect(stageSessionAudioArtifactMock).toHaveBeenCalledTimes(1);
    expect(reserveStorageBytesMock).not.toHaveBeenCalled();
  });

  it('覆盖后变小 → 由 publish 删除旧物理对象后释放旧账本行', async () => {
    resolveSessionAudioLocationMock.mockResolvedValue({
      kind: 'local',
      filePath: '/tmp/x',
      size: AUDIO_BYTES + 500,
      contentType: 'audio/webm',
    });

    await POST(makeReq(), { params });

    expect(reserveStorageBytesMock).not.toHaveBeenCalled();
    expect(releaseStorageBytesMock).not.toHaveBeenCalled();
    expect(finalizeStagedArtifactPublishMock).toHaveBeenCalledTimes(1);
  });

  it('媒体实测时长是唯一发布口径，durationMs 真实落库', async () => {
    measureAuthoritativeRecordingDurationMsFromBufferMock.mockResolvedValue(125_000);

    await POST(makeReq(), { params });

    expect(measureAuthoritativeRecordingDurationMsFromBufferMock).toHaveBeenCalled();
    expect(sessionUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ durationMs: 125_000 }),
      })
    );
  });

  it('库中已有时长也不能覆盖媒体实测结果', async () => {
    sessionFindUniqueMock.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      status: 'RECORDING',
      durationMs: 60_000,
      recordingPath: null,
    });
    measureAuthoritativeRecordingDurationMsFromBufferMock.mockResolvedValue(45_000);

    await POST(makeReq(), { params });

    expect(sessionUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ durationMs: 45_000 }),
      })
    );
  });

  it('SEC-018：库里已有极小正值也必须测量媒体时长', async () => {
    sessionFindUniqueMock.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      status: 'RECORDING',
      durationMs: 1,
      recordingPath: null,
    });
    measureAuthoritativeRecordingDurationMsFromBufferMock.mockResolvedValue(
      3 * 60 * 60_000
    );

    await POST(makeReq(), { params });

    expect(measureAuthoritativeRecordingDurationMsFromBufferMock).toHaveBeenCalledTimes(1);
    expect(sessionUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ durationMs: 3 * 60 * 60_000 }),
      })
    );
  });

  it('SEC-018：权威测量失败 → 422，绝不 stage 或发布录音', async () => {
    measureAuthoritativeRecordingDurationMsFromBufferMock.mockRejectedValue(
      new RecordingDurationMeasurementError()
    );

    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(422);
    expect(stageSessionAudioArtifactMock).not.toHaveBeenCalled();
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
    expect(finalizeStagedArtifactPublishMock).not.toHaveBeenCalled();
  });

  it('自动停止/codec 尾帧的一分钟余量仍按真实时长发布', async () => {
    measureAuthoritativeRecordingDurationMsFromBufferMock.mockResolvedValue(
      4 * 60 * 60_000 + 30_000
    );

    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(200);
    expect(sessionUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          durationMs: 4 * 60 * 60_000 + 30_000,
        }),
      })
    );
  });

  it('超出角色上限及收尾余量 → 422 且不发布', async () => {
    measureAuthoritativeRecordingDurationMsFromBufferMock.mockResolvedValue(
      4 * 60 * 60_000 + 60_001
    );

    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(422);
    expect(stageSessionAudioArtifactMock).not.toHaveBeenCalled();
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });
});
