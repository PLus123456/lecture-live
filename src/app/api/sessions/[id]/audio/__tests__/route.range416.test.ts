import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 审计 #7：GET /api/sessions/[id]/audio 的 Cloudreve 流式读取遇到 Range 不可满足（416）时，
 * 旧代码把它当普通流式失败落进缓冲回退 —— loadSessionAudioArtifact 不设上限地把整段录音读进
 * 内存后才返回 416（share 路由早在 P4-3 修过，这条 owner 路由漏了）。
 */

const {
  verifyAuthMock,
  enforceRateLimitMock,
  sessionFindUniqueMock,
  resolveSessionAudioLocationMock,
  loadSessionAudioArtifactMock,
  openDownloadStreamMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  resolveSessionAudioLocationMock: vi.fn(),
  loadSessionAudioArtifactMock: vi.fn(),
  openDownloadStreamMock: vi.fn(),
}));

const { RangeErrorClass } = vi.hoisted(() => {
  class RangeErrorClass extends Error {
    contentRange: string | null;
    constructor(contentRange: string | null) {
      super('Cloudreve range not satisfiable');
      this.name = 'CloudreveRangeNotSatisfiableError';
      this.contentRange = contentRange;
    }
  }
  return { RangeErrorClass };
});

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: { session: { findUnique: sessionFindUniqueMock } },
}));
vi.mock('@/lib/apiResponseCache', () => ({ invalidateSessionsApiCache: vi.fn() }));
vi.mock('@/lib/security', () => ({
  assertOwnership: vi.fn(),
  assertSessionReadAccess: vi.fn(() => ({ isCrossUserAdmin: false })),
}));
vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));
vi.mock('@/lib/recordingDraftPersistence', () => ({
  deleteRecordingDraft: vi.fn(async () => undefined),
}));
vi.mock('@/lib/sessionPersistence', () => ({
  stageSessionAudioArtifact: vi.fn(),
  settleStagedArtifactsInTransaction: vi.fn(),
  completeStagedArtifactPublishes: vi.fn(),
  readbackStagedArtifactPublication: vi.fn(),
  rollbackStagedArtifact: vi.fn(),
  loadSessionAudioArtifact: loadSessionAudioArtifactMock,
  resolveSessionAudioLocation: resolveSessionAudioLocationMock,
  openLocalAudioRangeStream: vi.fn(),
}));
vi.mock('@/lib/storage/cloudreve', () => ({
  CloudreveStorage: {
    create: vi.fn(async () => ({ openDownloadStream: openDownloadStreamMock })),
  },
  CloudreveRangeNotSatisfiableError: RangeErrorClass,
}));
vi.mock('@/lib/audio/recordingDuration', () => ({
  normalizeRecordedAudioDuration: vi.fn(),
  measureAuthoritativeRecordingDurationMsFromBuffer: vi.fn(),
  RECORDING_DURATION_LIMIT_GRACE_MS: 60_000,
  RecordingDurationMeasurementError: class RecordingDurationMeasurementError extends Error {},
}));
vi.mock('@/lib/billing', () => ({ getMaxSessionDurationMs: () => null }));
vi.mock('@/lib/quota', () => ({ checkQuota: vi.fn() }));
vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  StoredArtifactQuotaExceededError: class StoredArtifactQuotaExceededError extends Error {},
}));

import { GET } from '@/app/api/sessions/[id]/audio/route';

const params = Promise.resolve({ id: 's1' });

function rangeRequest(range: string) {
  return new Request('http://localhost:3000/api/sessions/s1/audio', {
    headers: { range },
  });
}

describe('GET /api/sessions/[id]/audio Cloudreve Range 416（审计 #7）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'u1', role: 'PRO' });
    enforceRateLimitMock.mockResolvedValue(null);
    sessionFindUniqueMock.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      recordingPath: '/u1/recordings/s1-x.webm',
      enhancedAudioPath: null,
    });
    resolveSessionAudioLocationMock.mockResolvedValue({
      kind: 'cloudreve',
      remotePath: '/u1/recordings/s1-x.webm',
      userId: 'u1',
      contentType: 'audio/webm',
    });
    loadSessionAudioArtifactMock.mockResolvedValue({
      data: Buffer.alloc(16),
      fileName: 's1.webm',
      contentType: 'audio/webm',
      path: '/u1/recordings/s1-x.webm',
    });
  });

  it('上游 Range 不可满足 → 直接 416，绝不退到整文件缓冲读取', async () => {
    openDownloadStreamMock.mockRejectedValue(new RangeErrorClass('bytes */4096'));

    const res = await GET(rangeRequest('bytes=999999999-'), { params });

    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */4096');
    expect(loadSessionAudioArtifactMock).not.toHaveBeenCalled();
  });

  it('其它流式失败（远程节点错误）仍走既有的缓冲回退', async () => {
    openDownloadStreamMock.mockRejectedValue(new Error('Cloudreve 文件下载失败 (502)'));

    const res = await GET(rangeRequest('bytes=0-3'), { params });

    expect(loadSessionAudioArtifactMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(206);
  });

  it.each(['cloudreve', 'local', 'buffered'])('%s 空录音应明确报错而非返回可播放的 200', async (kind) => {
    if (kind === 'cloudreve') {
      openDownloadStreamMock.mockResolvedValue(new Response(null, { headers: { 'content-length': '0' } }));
    } else if (kind === 'local') {
      resolveSessionAudioLocationMock.mockResolvedValue({ kind: 'local', size: 0, filePath: '/unused.webm' });
    } else {
      resolveSessionAudioLocationMock.mockResolvedValue(null);
      loadSessionAudioArtifactMock.mockResolvedValue({ data: Buffer.alloc(0) });
    }
    const res = await GET(new Request('http://localhost/api/sessions/s1/audio'), { params });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'audio_empty' });
  });
});
