import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthMock,
  sessionFindUniqueMock,
  isRecordingDraftSealedMock,
  persistTranscriptDraftMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  isRecordingDraftSealedMock: vi.fn(),
  persistTranscriptDraftMock: vi.fn(),
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

import { PUT } from '@/app/api/sessions/[id]/transcript/draft/route';

const params = Promise.resolve({ id: 'session-1' });
const putReq = () =>
  new Request('http://localhost:3000/api/sessions/session-1/transcript/draft', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segments: [{ text: 'late' }], summaries: [], translations: {} }),
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
