import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthMock,
  sessionFindUniqueMock,
  isRecordingDraftSealedMock,
  persistTranscriptDraftMock,
  enforceRateLimitMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  isRecordingDraftSealedMock: vi.fn(),
  persistTranscriptDraftMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: { session: { findUnique: sessionFindUniqueMock } },
}));
vi.mock('@/lib/security', () => ({ assertOwnership: vi.fn() }));
vi.mock('@/lib/transcriptDraftPersistence', () => ({
  deleteTranscriptDraft: vi.fn(),
  loadTranscriptDraft: vi.fn(),
  loadTranscriptDraftManifest: vi.fn(),
  persistTranscriptDraft: persistTranscriptDraftMock,
}));
vi.mock('@/lib/recordingDraftPersistence', () => ({
  isRecordingDraftSealed: isRecordingDraftSealedMock,
}));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));

import { PUT } from '@/app/api/sessions/[id]/transcript/draft/route';

const params = Promise.resolve({ id: 'session-1' });
const validSegment = (overrides: Record<string, unknown> = {}) => ({
  id: 'segment-1',
  sessionIndex: 0,
  speaker: 'Speaker 1',
  language: 'en',
  text: 'late',
  globalStartMs: 0,
  globalEndMs: 1_000,
  startMs: 0,
  endMs: 1_000,
  isFinal: true,
  confidence: 1,
  timestamp: '00:00:00',
  ...overrides,
});
const putReq = () =>
  new Request('http://localhost:3000/api/sessions/session-1/transcript/draft', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segments: [validSegment()], summaries: [], translations: {} }),
  });

describe('transcript/draft PUT sealed 栅栏 (P1-7)', () => {
  beforeEach(() => {
    verifyAuthMock.mockReset().mockResolvedValue({ id: 'user-1', role: 'PRO' });
    sessionFindUniqueMock.mockReset().mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      status: 'FINALIZING',
    });
    persistTranscriptDraftMock
      .mockReset()
      .mockResolvedValue({ segmentCount: 1, updatedAt: Date.now() });
    isRecordingDraftSealedMock.mockReset();
    enforceRateLimitMock.mockReset().mockResolvedValue(null);
  });

  it('草稿已 seal → 迟到转录草稿 PUT 返回 409，不落盘', async () => {
    isRecordingDraftSealedMock.mockResolvedValue(true);

    const response = await PUT(putReq(), { params });

    expect(response.status).toBe(409);
    await expect((response.json() as Promise<Record<string, unknown>>)).resolves.toMatchObject({
      sealed: true,
    });
    expect(persistTranscriptDraftMock).not.toHaveBeenCalled();
  });

  it('未 seal → 正常落盘 200', async () => {
    isRecordingDraftSealedMock.mockResolvedValue(false);

    const response = await PUT(putReq(), { params });

    expect(response.status).toBe(200);
    expect(persistTranscriptDraftMock).toHaveBeenCalledTimes(1);
  });
});

// P4-5：只有元素个数上限（MAX_SEGMENTS=10000 等），对单个 segment 的体积零校验；PUT 还无限流。
// 冲突分支每次都把整份载荷写成一份新备份 —— 体积闸与限流是这条放大器的两道前置闸。
describe('transcript/draft PUT 体积闸与限流 (P4-5)', () => {
  beforeEach(() => {
    verifyAuthMock.mockReset().mockResolvedValue({ id: 'user-1', role: 'PRO' });
    sessionFindUniqueMock.mockReset().mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      status: 'RECORDING',
    });
    persistTranscriptDraftMock
      .mockReset()
      .mockResolvedValue({ segmentCount: 1, updatedAt: Date.now() });
    isRecordingDraftSealedMock.mockReset().mockResolvedValue(false);
    enforceRateLimitMock.mockReset().mockResolvedValue(null);
  });

  it('超过体积上限的载荷返回 413，且不落盘', async () => {
    // 段数远低于 MAX_SEGMENTS（数量闸放行），但单段巨大 —— 旧代码照单全收。
    const huge = {
      segments: Array.from({ length: 10 }, () => ({ text: 'x'.repeat(1_000_000) })),
      summaries: [],
      translations: {},
    };
    const response = await PUT(
      new Request('http://localhost:3000/api/sessions/session-1/transcript/draft', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(huge),
      }),
      { params }
    );

    expect(response.status).toBe(413);
    expect(persistTranscriptDraftMock).not.toHaveBeenCalled();
  });

  it('限流命中返回 429，且不落盘', async () => {
    enforceRateLimitMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 })
    );

    const response = await PUT(putReq(), { params });

    expect(response.status).toBe(429);
    expect(persistTranscriptDraftMock).not.toHaveBeenCalled();
    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'user:user-1:session:session-1' })
    );
  });

  it('段内夹带未知深层对象返回 400，且不落盘', async () => {
    const response = await PUT(
      new Request('http://localhost:3000/api/sessions/session-1/transcript/draft', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segments: [validSegment({ attacker: { nested: { payload: 'x' } } })],
          summaries: [],
          translations: {},
        }),
      }),
      { params }
    );

    expect(response.status).toBe(400);
    expect(persistTranscriptDraftMock).not.toHaveBeenCalled();
  });
});
