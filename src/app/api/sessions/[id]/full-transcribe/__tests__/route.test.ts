import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthMock,
  sessionFindUniqueMock,
  claimMock,
  registerMock,
  failClaimMock,
  prepareInputMock,
  cleanupMock,
  measureDurationMock,
  getSiteSettingsMock,
  processFullMock,
  rateLimitMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  claimMock: vi.fn(),
  registerMock: vi.fn(),
  failClaimMock: vi.fn(),
  prepareInputMock: vi.fn(),
  cleanupMock: vi.fn(),
  measureDurationMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  processFullMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/requestLogger', () => ({
  withRequestLogging: (_name: string, handler: unknown) => handler,
}));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: rateLimitMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: { session: { findUnique: sessionFindUniqueMock } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/billing', () => ({
  getBillableMinutes: (ms: number) => Math.ceil(ms / 60_000),
  getMaxSessionDurationMs: (role: string) =>
    role === 'ADMIN' ? null : role === 'PRO' ? 4 * 60 * 60_000 : 2 * 60 * 60_000,
}));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/audio/fullTranscribeProcessor', () => ({
  processFullTranscribe: processFullMock,
}));
vi.mock('@/lib/audio/fullTranscribeAdmission', () => ({
  FULL_TRANSCRIBE_ACTIVE_STATES: [
    'pending',
    'transcoding',
    'transcribing',
    'finalizing',
  ],
  claimFullTranscribeTask: claimMock,
  registerFullTranscribeReservation: registerMock,
  failFullTranscribeClaim: failClaimMock,
}));
vi.mock('@/lib/audio/fullTranscribeInput', () => {
  class FullTranscribeInputTooLargeError extends Error {
    constructor(readonly maxBytes: number) {
      super('too large');
      this.name = 'FullTranscribeInputTooLargeError';
    }
  }
  class FullTranscribeInputUnavailableError extends Error {
    constructor(message = 'unavailable') {
      super(message);
      this.name = 'FullTranscribeInputUnavailableError';
    }
  }
  return {
    FullTranscribeInputTooLargeError,
    FullTranscribeInputUnavailableError,
    prepareFullTranscribeInput: prepareInputMock,
    cleanupFullTranscribeWorkDir: cleanupMock,
  };
});
vi.mock('@/lib/audio/recordingDuration', () => {
  class RecordingDurationMeasurementError extends Error {
    constructor(message = 'measurement failed') {
      super(message);
      this.name = 'RecordingDurationMeasurementError';
    }
  }
  return {
    RecordingDurationMeasurementError,
    RECORDING_DURATION_LIMIT_GRACE_MS: 60_000,
    measureAuthoritativeRecordingDurationMs: measureDurationMock,
  };
});

import { POST } from '@/app/api/sessions/[id]/full-transcribe/route';
import {
  FullTranscribeInputTooLargeError,
} from '@/lib/audio/fullTranscribeInput';
import { RecordingDurationMeasurementError } from '@/lib/audio/recordingDuration';

const params = Promise.resolve({ id: 's-1' });
const input = {
  inputPath: '/safe/recording.webm',
  workDir: '/safe/work/s-1--claim-1',
  contentType: 'audio/webm',
  sizeBytes: 1024,
  source: 'local' as const,
};

function makeReq(): Request {
  return new Request('http://localhost/api/sessions/s-1/full-transcribe', {
    method: 'POST',
  });
}

function completedSession(over: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    userId: 'user-1',
    status: 'COMPLETED',
    recordingPath: 'local:recording.webm',
    durationMs: 600_000,
    fullTranscribeStatus: null,
    ...over,
  };
}

function claimed() {
  return {
    outcome: 'claimed' as const,
    claimId: 'claim-1',
    startedAt: new Date('2026-08-20T00:00:00Z'),
    session: {
      id: 's-1',
      userId: 'user-1',
      recordingPath: 'local:recording.webm',
    },
  };
}

describe('POST full-transcribe — claim-before-read and measured billing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'FREE' });
    sessionFindUniqueMock.mockResolvedValue(completedSession());
    claimMock.mockResolvedValue(claimed());
    prepareInputMock.mockResolvedValue(input);
    measureDurationMock.mockResolvedValue(42 * 60_000);
    getSiteSettingsMock.mockResolvedValue({ async_upload_billing_multiplier: 0.8 });
    registerMock.mockResolvedValue({ outcome: 'reserved' });
    failClaimMock.mockResolvedValue(true);
    cleanupMock.mockResolvedValue(undefined);
    processFullMock.mockResolvedValue(undefined);
    rateLimitMock.mockResolvedValue(null);
  });

  it('claims/admit resources before path resolution, measurement, reservation and processing', async () => {
    const response = await POST(makeReq(), { params });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'pending',
      estimatedMinutes: 34,
    });
    expect(claimMock).toHaveBeenCalledWith('s-1', 'user-1');
    expect(prepareInputMock).toHaveBeenCalledWith(claimed().session, 'claim-1');
    expect(measureDurationMock).toHaveBeenCalledWith(input.inputPath, {
      tempRoot: input.workDir,
    });
    expect(registerMock).toHaveBeenCalledWith({
      sessionId: 's-1',
      userId: 'user-1',
      claimId: 'claim-1',
      durationMs: 42 * 60_000,
      estimatedMinutes: 34,
    });
    expect(processFullMock).toHaveBeenCalledWith({
      sessionId: 's-1',
      claimId: 'claim-1',
      input,
      authoritativeDurationMs: 42 * 60_000,
    });

    expect(claimMock.mock.invocationCallOrder[0]).toBeLessThan(
      prepareInputMock.mock.invocationCallOrder[0]
    );
    expect(prepareInputMock.mock.invocationCallOrder[0]).toBeLessThan(
      measureDurationMock.mock.invocationCallOrder[0]
    );
    expect(measureDurationMock.mock.invocationCallOrder[0]).toBeLessThan(
      registerMock.mock.invocationCallOrder[0]
    );
    expect(registerMock.mock.invocationCallOrder[0]).toBeLessThan(
      processFullMock.mock.invocationCallOrder[0]
    );
  });

  it('does not trust a tiny positive stored duration', async () => {
    sessionFindUniqueMock.mockResolvedValueOnce(completedSession({ durationMs: 1 }));
    measureDurationMock.mockResolvedValueOnce(10 * 60_000);

    const response = await POST(makeReq(), { params });

    expect(response.status).toBe(200);
    expect(measureDurationMock).toHaveBeenCalledOnce();
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 10 * 60_000, estimatedMinutes: 8 })
    );
  });

  it('two concurrent same-session triggers let only the claim winner touch audio', async () => {
    claimMock
      .mockResolvedValueOnce(claimed())
      .mockResolvedValueOnce({ outcome: 'already_running', status: 'pending' });

    const [winner, loser] = await Promise.all([
      POST(makeReq(), { params }),
      POST(makeReq(), { params }),
    ]);

    expect(winner.status).toBe(200);
    expect(loser.status).toBe(200);
    await expect(loser.json()).resolves.toMatchObject({ alreadyRunning: true });
    expect(claimMock).toHaveBeenCalledTimes(2);
    expect(prepareInputMock).toHaveBeenCalledTimes(1);
    expect(measureDurationMock).toHaveBeenCalledTimes(1);
    expect(processFullMock).toHaveBeenCalledTimes(1);
  });

  it('fast-path active status performs no claim or file work', async () => {
    sessionFindUniqueMock.mockResolvedValueOnce(
      completedSession({ fullTranscribeStatus: 'transcribing' })
    );

    const response = await POST(makeReq(), { params });

    expect(response.status).toBe(200);
    expect(claimMock).not.toHaveBeenCalled();
    expect(prepareInputMock).not.toHaveBeenCalled();
  });

  it('rate-limits repeated expensive triggers before session lookup or claim', async () => {
    rateLimitMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 })
    );

    const response = await POST(makeReq(), { params });

    expect(response.status).toBe(429);
    expect(sessionFindUniqueMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
    expect(prepareInputMock).not.toHaveBeenCalled();
  });

  it('user/global admission rejection happens before file work', async () => {
    claimMock.mockResolvedValueOnce({ outcome: 'user_busy' });
    const userBusy = await POST(makeReq(), { params });
    expect(userBusy.status).toBe(429);
    expect(userBusy.headers.get('retry-after')).toBe('30');

    claimMock.mockResolvedValueOnce({ outcome: 'global_busy' });
    const globalBusy = await POST(makeReq(), { params });
    expect(globalBusy.status).toBe(503);
    expect(prepareInputMock).not.toHaveBeenCalled();
  });

  it('quota rejection fails inside reservation transaction and removes temp input', async () => {
    registerMock.mockResolvedValueOnce({ outcome: 'insufficient_quota' });

    const response = await POST(makeReq(), { params });

    expect(response.status).toBe(402);
    expect(cleanupMock).toHaveBeenCalledWith('s-1', 'claim-1');
    expect(processFullMock).not.toHaveBeenCalled();
  });

  it('measurement failure marks only this claim failed and cleans temp', async () => {
    measureDurationMock.mockRejectedValueOnce(
      new RecordingDurationMeasurementError('decode failed')
    );

    const response = await POST(makeReq(), { params });

    expect(response.status).toBe(409);
    expect(failClaimMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's-1', claimId: 'claim-1' })
    );
    expect(cleanupMock).toHaveBeenCalledWith('s-1', 'claim-1');
    expect(registerMock).not.toHaveBeenCalled();
    expect(processFullMock).not.toHaveBeenCalled();
  });

  it('actual streamed bytes over the cap return 413 and release the claim', async () => {
    prepareInputMock.mockRejectedValueOnce(new FullTranscribeInputTooLargeError(1024));

    const response = await POST(makeReq(), { params });

    expect(response.status).toBe(413);
    expect(failClaimMock).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: 'claim-1', error: 'Recording is too large for full transcription' })
    );
    expect(measureDurationMock).not.toHaveBeenCalled();
  });

  it('does not clamp an over-role recording into a cheaper billable duration', async () => {
    measureDurationMock.mockResolvedValueOnce(2 * 60 * 60_000 + 60_001);

    const response = await POST(makeReq(), { params });

    expect(response.status).toBe(409);
    expect(registerMock).not.toHaveBeenCalled();
    expect(failClaimMock).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 2 * 60 * 60_000 + 60_001 })
    );
  });

  it('keeps the publish-path one-minute codec tail grace but bills the real duration', async () => {
    measureDurationMock.mockResolvedValueOnce(2 * 60 * 60_000 + 30_000);

    const response = await POST(makeReq(), { params });

    expect(response.status).toBe(200);
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 2 * 60 * 60_000 + 30_000,
        estimatedMinutes: 97,
      })
    );
  });

  it('preserves auth, ownership and finalized-session gates before claim', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);
    expect((await POST(makeReq(), { params })).status).toBe(401);

    sessionFindUniqueMock.mockResolvedValueOnce(
      completedSession({ userId: 'someone-else' })
    );
    expect((await POST(makeReq(), { params })).status).toBe(403);

    sessionFindUniqueMock.mockResolvedValueOnce(completedSession({ status: 'RECORDING' }));
    expect((await POST(makeReq(), { params })).status).toBe(409);

    expect(claimMock).not.toHaveBeenCalled();
  });
});
