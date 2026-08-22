import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyAuth: vi.fn(),
  sessionFindUnique: vi.fn(),
  enforceRateLimit: vi.fn(),
  finalizeSession: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: mocks.verifyAuth }));
vi.mock('@/lib/prisma', () => ({
  prisma: { session: { findUnique: mocks.sessionFindUnique } },
}));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/requestLogger', () => ({
  withRequestLogging:
    (_scope: string, handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock('@/lib/apiResponseCache', () => ({
  invalidateSessionsApiCache: vi.fn(),
}));
vi.mock('@/lib/sessionFinalization', () => ({
  finalizeSession: mocks.finalizeSession,
  FinalizeSessionError: class FinalizeSessionError extends Error {},
}));
vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));

import { POST } from '@/app/api/sessions/[id]/finalize/route';

const params = Promise.resolve({ id: 'session-1' });
const validSegment = (overrides: Record<string, unknown> = {}) => ({
  id: 'segment-1',
  sessionIndex: 0,
  speaker: 'Speaker 1',
  language: 'en',
  text: 'Normal transcript',
  globalStartMs: 0,
  globalEndMs: 1_000,
  startMs: 0,
  endMs: 1_000,
  isFinal: true,
  confidence: 1,
  timestamp: '00:00:00',
  ...overrides,
});

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/sessions/session-1/finalize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('session finalize transcript admission (SEC-009)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyAuth.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    mocks.sessionFindUnique.mockResolvedValue({
      status: 'FINALIZING',
      userId: 'user-1',
    });
    mocks.enforceRateLimit.mockResolvedValue(null);
    mocks.finalizeSession.mockResolvedValue({
      success: true,
      recordingPath: null,
      transcriptPath: 'local:transcripts/session-1.json',
      summaryPath: 'local:summaries/session-1.json',
    });
  });

  it('accepts the ordinary strict transcript bundle and finalizes it', async () => {
    const response = await POST(
      request({
        segments: [validSegment()],
        summaries: [],
        translations: { 'segment-1': '正常译文' },
        durationMs: 1_000,
        title: 'Lecture',
      }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(mocks.finalizeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        clientBundle: expect.objectContaining({
          segments: [expect.objectContaining({ id: 'segment-1' })],
        }),
      })
    );
  });

  it('preserves empty-body and empty-object draft-only finalize retries', async () => {
    const emptyBodyResponse = await POST(
      new Request('http://localhost/api/sessions/session-1/finalize', {
        method: 'POST',
      }),
      { params }
    );
    const emptyObjectResponse = await POST(request({}), { params });

    expect(emptyBodyResponse.status).toBe(200);
    expect(emptyObjectResponse.status).toBe(200);
    expect(mocks.finalizeSession).toHaveBeenCalledTimes(2);
    expect(mocks.finalizeSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ clientBundle: null })
    );
  });

  it('rejects an incomplete transcript bundle instead of falling back to a draft', async () => {
    const response = await POST(request({ segments: [] }), { params });

    expect(response.status).toBe(400);
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
  });

  it('rejects an unknown nested segment field before finalizeSession', async () => {
    const response = await POST(
      request({
        segments: [validSegment({ nested: { attacker: ['payload'] } })],
        summaries: [],
        translations: {},
      }),
      { params }
    );

    expect(response.status).toBe(400);
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared body before reading or finalizing', async () => {
    const response = await POST(
      request({}, { 'content-length': String(8 * 1024 * 1024 + 1) }),
      { params }
    );

    expect(response.status).toBe(413);
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
  });

  it('authorizes and short-circuits completed retries without parsing their body', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      status: 'COMPLETED',
      userId: 'user-1',
      recordingPath: 'recording.webm',
      transcriptPath: 'transcript.json',
      summaryPath: 'summary.json',
      durationMs: 1_000,
    });
    const response = await POST(
      request({}, { 'content-length': String(8 * 1024 * 1024 + 1) }),
      { params }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      alreadyCompleted: true,
    });
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
  });

  it('rejects a foreign completed session before parsing its body', async () => {
    mocks.sessionFindUnique.mockResolvedValue({
      status: 'COMPLETED',
      userId: 'user-2',
    });
    const response = await POST(
      request({}, { 'content-length': String(8 * 1024 * 1024 + 1) }),
      { params }
    );

    expect(response.status).toBe(403);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
  });
});
