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
  finalizeStagedArtifactPublishMock,
  rollbackStagedArtifactMock,
  normalizeRecordedAudioDurationMock,
  resolveExpectedRecordingDurationMsMock,
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
  finalizeStagedArtifactPublishMock: vi.fn(),
  rollbackStagedArtifactMock: vi.fn(),
  normalizeRecordedAudioDurationMock: vi.fn(),
  resolveExpectedRecordingDurationMsMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findUnique: sessionFindUniqueMock,
      updateMany: sessionUpdateManyMock,
    },
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
}));
vi.mock('@/lib/sessionPersistence', () => ({
  stageSessionAudioArtifact: stageSessionAudioArtifactMock,
  finalizeStagedArtifactPublish: finalizeStagedArtifactPublishMock,
  rollbackStagedArtifact: rollbackStagedArtifactMock,
}));
vi.mock('@/lib/audio/recordingDuration', () => ({
  normalizeRecordedAudioDuration: normalizeRecordedAudioDurationMock,
  resolveExpectedRecordingDurationMs: resolveExpectedRecordingDurationMsMock,
}));
vi.mock('@/lib/billing', () => ({
  clampSessionDurationMs: (ms: number) => ms,
}));

import { POST } from '@/app/api/sessions/[id]/audio/draft/finalize/route';

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
    finalizeStagedArtifactPublishMock
      .mockReset()
      .mockResolvedValue({ path: 'local:recordings/sess-1-x.webm', storage: 'local' });
    rollbackStagedArtifactMock.mockReset().mockResolvedValue(undefined);
    normalizeRecordedAudioDurationMock.mockReset().mockImplementation(async ({ buffer }) => buffer);
    resolveExpectedRecordingDurationMsMock.mockReset().mockResolvedValue(120_000);
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
});
