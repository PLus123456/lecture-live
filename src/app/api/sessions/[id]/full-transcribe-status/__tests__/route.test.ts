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
import { finalizeFullTranscription } from '@/lib/audio/fullTranscribeFinalize';
import { prisma } from '@/lib/prisma';

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

describe('full-transcribe status 收尾失败的瞬时 / 永久分流（审计 #8）', () => {
  const finalizeMock = vi.mocked(finalizeFullTranscription);
  const updateManyMock = vi.mocked(prisma.session.updateMany);

  beforeEach(() => {
    // mockReset 才会清掉上一条用例残留的 mockResolvedValueOnce 队列（clearAllMocks 不清）。
    findUniqueMock.mockReset();
    findUniqueMock.mockResolvedValue(activeSession);
    getTranscriptionMock.mockResolvedValue({ status: 'completed' });
  });

  it('永久失败 → claim 绑定地标 failed 并释放预留（只从 transcribing 转出），返回 failed', async () => {
    finalizeMock.mockRejectedValue(
      Object.assign(new Error('Soniox transcript.tokens must be an array'), {
        name: 'SonioxTranscriptPayloadError',
      })
    );

    const response = await GET(new Request('http://localhost/status'), { params });

    // 修复前：一律回退 transcribing —— 每次 poll 重下 transcript 再失败，任务永久卡住，
    // 占着补全名额与额度预留。
    await expect(response.json()).resolves.toMatchObject({
      status: 'failed',
      hasFullTranscript: false,
    });
    expect(failAttemptMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      claimId: 'claim-a',
      allowedStatuses: ['transcribing'],
      error: 'Full transcription could not be finalized',
    });
    expect(deleteTranscriptionMock).toHaveBeenCalledWith(expect.any(Object), 'job-a');
    expect(deleteFileMock).toHaveBeenCalledWith(expect.any(Object), 'file-a');
  });

  it('永久失败但已被新 claim 接管 → 不报旧失败、不清 Soniox 资源', async () => {
    finalizeMock.mockRejectedValue(new Error('Soniox get transcript failed: HTTP 404'));
    failAttemptMock.mockResolvedValueOnce(false);
    findUniqueMock.mockResolvedValueOnce(activeSession).mockResolvedValueOnce({
      fullTranscribeStatus: 'finalizing',
      fullTranscribeError: null,
      fullTranscriptPath: null,
    });

    const response = await GET(new Request('http://localhost/status'), { params });

    await expect(response.json()).resolves.toEqual({
      status: 'finalizing',
      error: null,
      hasFullTranscript: false,
    });
    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(deleteTranscriptionMock).not.toHaveBeenCalled();
  });

  it('瞬时失败 → 回退 transcribing 交下一轮 poll，绝不标 failed', async () => {
    finalizeMock.mockRejectedValue(new Error('Soniox get transcript failed: HTTP 503'));

    const response = await GET(new Request('http://localhost/status'), { params });

    await expect(response.json()).resolves.toEqual({
      status: 'transcribing',
      error: null,
      hasFullTranscript: false,
    });
    expect(failAttemptMock).not.toHaveBeenCalled();
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fullTranscribeClaimId: 'claim-a',
          fullTranscribeStatus: 'finalizing',
        }),
        data: { fullTranscribeStatus: 'transcribing' },
      })
    );
  });
});
