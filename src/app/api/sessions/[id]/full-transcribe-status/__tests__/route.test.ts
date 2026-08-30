import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthMock,
  findUniqueMock,
  getTranscriptionMock,
  deleteFileMock,
  deleteTranscriptionMock,
  failAttemptMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  findUniqueMock: vi.fn(),
  getTranscriptionMock: vi.fn(),
  deleteFileMock: vi.fn(),
  deleteTranscriptionMock: vi.fn(),
  failAttemptMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: { session: { findUnique: findUniqueMock, updateMany: vi.fn() } },
}));
vi.mock('@/lib/security', () => ({ assertOwnership: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/soniox/env', () => ({
  resolveSonioxConfigForSessionRegion: vi.fn(async () => ({
    restBaseUrl: 'https://soniox.example',
    apiKey: 'secret',
  })),
}));
vi.mock('@/lib/soniox/asyncFile', () => ({
  getSonioxTranscription: getTranscriptionMock,
  deleteSonioxFile: deleteFileMock,
  deleteSonioxTranscription: deleteTranscriptionMock,
}));
vi.mock('@/lib/audio/fullTranscribeFinalize', () => ({
  finalizeFullTranscription: vi.fn(),
}));
vi.mock('@/lib/audio/fullTranscribeAdmission', () => ({
  failFullTranscribeAttempt: failAttemptMock,
}));

import { GET } from '@/app/api/sessions/[id]/full-transcribe-status/route';

const params = Promise.resolve({ id: 'session-1' });
const activeSession = {
  id: 'session-1',
  userId: 'user-1',
  fullTranscribeStatus: 'transcribing',
  fullTranscribeClaimId: 'claim-a',
  fullTranscribeError: null,
  fullTranscriptPath: null,
  fullSonioxFileId: 'file-a',
  fullSonioxTranscriptionId: 'job-a',
  sonioxRegion: 'eu',
};

beforeEach(() => {
  vi.clearAllMocks();
  verifyAuthMock.mockResolvedValue({ id: 'user-1' });
  findUniqueMock.mockResolvedValue(activeSession);
  getTranscriptionMock.mockResolvedValue({ status: 'error' });
  failAttemptMock.mockResolvedValue(true);
  deleteFileMock.mockResolvedValue(true);
  deleteTranscriptionMock.mockResolvedValue(true);
});

describe('full-transcribe status claim isolation', () => {
  it('atomically fails and releases only the polled attempt before remote cleanup', async () => {
    const response = await GET(new Request('http://localhost/status'), { params });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'failed' });
    expect(failAttemptMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      claimId: 'claim-a',
      allowedStatuses: ['transcribing'],
      error: 'Soniox transcription failed',
    });
    expect(deleteFileMock).toHaveBeenCalledWith(expect.any(Object), 'file-a');
    expect(deleteTranscriptionMock).toHaveBeenCalledWith(
      expect.any(Object),
      'job-a'
    );
  });

  it('does not delete resources or report old failure after a newer claim wins', async () => {
    failAttemptMock.mockResolvedValueOnce(false);
    findUniqueMock
      .mockResolvedValueOnce(activeSession)
      .mockResolvedValueOnce({
        fullTranscribeStatus: 'pending',
        fullTranscribeError: null,
        fullTranscriptPath: null,
      });

    const response = await GET(new Request('http://localhost/status'), { params });

    await expect(response.json()).resolves.toEqual({
      status: 'pending',
      error: null,
      hasFullTranscript: false,
    });
    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(deleteTranscriptionMock).not.toHaveBeenCalled();
  });
});
