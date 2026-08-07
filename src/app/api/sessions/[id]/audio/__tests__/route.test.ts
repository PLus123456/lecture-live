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
  resolveExpectedRecordingDurationMsMock,
  probeAudioDurationMsFromBufferMock,
  normalizeRecordedAudioDurationMock,
  stageSessionAudioArtifactMock,
  finalizeStagedArtifactPublishMock,
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
  resolveExpectedRecordingDurationMsMock: vi.fn(),
  probeAudioDurationMsFromBufferMock: vi.fn(),
  normalizeRecordedAudioDurationMock: vi.fn(),
  stageSessionAudioArtifactMock: vi.fn(),
  finalizeStagedArtifactPublishMock: vi.fn(),
  rollbackStagedArtifactMock: vi.fn(),
  resolveSessionAudioLocationMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { findUnique: sessionFindUniqueMock, updateMany: sessionUpdateManyMock },
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
  finalizeStagedArtifactPublish: finalizeStagedArtifactPublishMock,
  rollbackStagedArtifact: rollbackStagedArtifactMock,
  loadSessionAudioArtifact: vi.fn(),
  resolveSessionAudioLocation: resolveSessionAudioLocationMock,
  openLocalAudioRangeStream: vi.fn(),
}));
vi.mock('@/lib/storage/cloudreve', () => ({ CloudreveStorage: { create: vi.fn() } }));
vi.mock('@/lib/audio/recordingDuration', () => ({
  normalizeRecordedAudioDuration: normalizeRecordedAudioDurationMock,
  probeAudioDurationMsFromBuffer: probeAudioDurationMsFromBufferMock,
  resolveExpectedRecordingDurationMs: resolveExpectedRecordingDurationMsMock,
}));
vi.mock('@/lib/billing', () => ({
  clampSessionDurationMs: (ms: number) => ms,
}));
vi.mock('@/lib/quota', () => ({
  checkQuota: checkQuotaMock,
  reserveStorageBytes: reserveStorageBytesMock,
  releaseStorageBytes: releaseStorageBytesMock,
}));

import { POST } from '@/app/api/sessions/[id]/audio/route';

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
    resolveExpectedRecordingDurationMsMock.mockResolvedValue(0);
    probeAudioDurationMsFromBufferMock.mockResolvedValue(0);
    normalizeRecordedAudioDurationMock.mockImplementation(
      async (o: { buffer: Buffer }) => o.buffer
    );
    resolveSessionAudioLocationMock.mockResolvedValue(null);
    stageSessionAudioArtifactMock.mockResolvedValue({
      reference: 'local:recordings/s1.webm',
      previousReference: null,
    });
    finalizeStagedArtifactPublishMock.mockResolvedValue({
      path: 'local:recordings/s1.webm',
      storage: 'local',
    });
  });

  it('首次上传 → 按字节数预留 storage_bytes', async () => {
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(reserveStorageBytesMock).toHaveBeenCalledWith('u1', AUDIO_BYTES);
  });

  it('字节配额不足 → 402，且绝不落盘/落库', async () => {
    reserveStorageBytesMock.mockResolvedValue(false);

    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(402);
    expect((await res.json()).quota).toBe('storage_bytes');
    expect(stageSessionAudioArtifactMock).not.toHaveBeenCalled();
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });

  it('终态会话 CAS 失败 → 回滚 staged 对象并退还刚预留的字节', async () => {
    sessionUpdateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(409);
    expect(rollbackStagedArtifactMock).toHaveBeenCalled();
    expect(releaseStorageBytesMock).toHaveBeenCalledWith('u1', AUDIO_BYTES);
  });

  it('覆盖本地旧录音 → 只预留净增量', async () => {
    resolveSessionAudioLocationMock.mockResolvedValue({
      kind: 'local',
      filePath: '/tmp/x',
      size: 400,
      contentType: 'audio/webm',
    });

    await POST(makeReq(), { params });

    expect(reserveStorageBytesMock).toHaveBeenCalledWith('u1', AUDIO_BYTES - 400);
  });

  it('覆盖后变小 → 把腾出的字节还回去', async () => {
    resolveSessionAudioLocationMock.mockResolvedValue({
      kind: 'local',
      filePath: '/tmp/x',
      size: AUDIO_BYTES + 500,
      contentType: 'audio/webm',
    });

    await POST(makeReq(), { params });

    expect(reserveStorageBytesMock).not.toHaveBeenCalled();
    expect(releaseStorageBytesMock).toHaveBeenCalledWith('u1', 500);
  });

  it('三个时长来源全为 0（从没连过 WS 的会话直传）→ ffprobe 兜底，durationMs 真实落库', async () => {
    probeAudioDurationMsFromBufferMock.mockResolvedValue(125_000);

    await POST(makeReq(), { params });

    expect(probeAudioDurationMsFromBufferMock).toHaveBeenCalled();
    expect(sessionUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ durationMs: 125_000 }),
      })
    );
  });

  it('已有可信时长 → 不多跑一次 ffprobe', async () => {
    resolveExpectedRecordingDurationMsMock.mockResolvedValue(60_000);

    await POST(makeReq(), { params });

    expect(probeAudioDurationMsFromBufferMock).not.toHaveBeenCalled();
    expect(sessionUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ durationMs: 60_000 }),
      })
    );
  });
});
