import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyAuth: vi.fn(),
  sessionFindUnique: vi.fn(),
  sessionUpdateMany: vi.fn(),
  enforceRateLimit: vi.fn(),
  stageArtifacts: vi.fn(),
  settleArtifacts: vi.fn(),
  completePublishes: vi.fn(),
  readbackPublication: vi.fn(),
  rollbackArtifact: vi.fn(),
  loadDraft: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: mocks.verifyAuth }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findUnique: mocks.sessionFindUnique,
      updateMany: mocks.sessionUpdateMany,
    },
    $transaction: vi.fn(async (callback) =>
      callback({ session: { updateMany: mocks.sessionUpdateMany } })
    ),
  },
}));
vi.mock('@/lib/security', () => ({
  assertOwnership: vi.fn(),
  assertSessionReadAccess: vi.fn(),
}));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));
vi.mock('@/lib/llm/folderKeywords', () => ({
  extractAndAccumulateKeywords: vi.fn(),
}));
vi.mock('@/lib/sessionPersistence', () => ({
  extractTranscriptText: vi.fn(() => 'Normal transcript'),
  loadSessionTranscriptBundle: vi.fn(),
  stageSessionTranscriptArtifacts: mocks.stageArtifacts,
  settleStagedArtifactsInTransaction: mocks.settleArtifacts,
  completeStagedArtifactPublishes: mocks.completePublishes,
  readbackStagedArtifactPublication: mocks.readbackPublication,
  rollbackStagedArtifact: mocks.rollbackArtifact,
}));
vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  StoredArtifactQuotaExceededError: class StoredArtifactQuotaExceededError extends Error {},
}));
vi.mock('@/lib/transcriptDraftPersistence', () => ({
  deleteTranscriptDraft: vi.fn(),
  loadTranscriptDraft: mocks.loadDraft,
}));
vi.mock('@/lib/apiResponseCache', () => ({
  invalidateFoldersApiCache: vi.fn(),
  invalidateSessionsApiCache: vi.fn(),
}));
vi.mock('@/lib/llm/embedding/transcriptRag', () => ({
  invalidateRagCache: vi.fn(),
}));

import { POST } from '@/app/api/sessions/[id]/transcript/route';
import { StoredArtifactQuotaExceededError } from '@/lib/storage/storedArtifactLedger';

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

function request(segment = validSegment()) {
  return new Request('http://localhost/api/sessions/session-1/transcript', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      segments: [segment],
      summaries: [],
      translations: {},
    }),
  });
}

describe('session transcript persistence admission (SEC-009)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyAuth.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    mocks.enforceRateLimit.mockResolvedValue(null);
    mocks.sessionFindUnique.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      status: 'RECORDING',
      folders: [],
    });
    mocks.sessionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.loadDraft.mockResolvedValue(null);
    mocks.stageArtifacts.mockResolvedValue({
      transcript: { reference: 'local:transcripts/staged.json' },
      summary: { reference: 'local:summaries/staged.json' },
    });
    mocks.settleArtifacts.mockResolvedValue([
      { staged: { reference: 'local:transcripts/staged.json' }, settled: {} },
      { staged: { reference: 'local:summaries/staged.json' }, settled: {} },
    ]);
    mocks.completePublishes.mockResolvedValue([
      {
        path: 'local:transcripts/session-1.json',
        storage: 'local',
      },
      {
        path: 'local:summaries/session-1.json',
        storage: 'local',
      },
    ]);
    mocks.rollbackArtifact.mockResolvedValue(undefined);
    mocks.readbackPublication.mockResolvedValue({
      outcome: 'not_committed',
      publications: [],
    });
  });

  it('persists an ordinary valid transcript', async () => {
    const response = await POST(request(), { params });

    expect(response.status).toBe(200);
    expect(mocks.stageArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1' }),
      expect.objectContaining({
        segments: [expect.objectContaining({ id: 'segment-1' })],
      })
    );
  });

  it('rejects an unknown nested field before staging any artifact', async () => {
    const response = await POST(
      request(validSegment({ payload: { nested: { attacker: true } } })),
      { params }
    );

    expect(response.status).toBe(400);
    expect(mocks.stageArtifacts).not.toHaveBeenCalled();
    expect(mocks.sessionUpdateMany).not.toHaveBeenCalled();
  });

  it('re-admits and canonicalizes a bounded legacy draft before staging', async () => {
    const legacySegment = validSegment();
    delete (legacySegment as { globalStartMs?: unknown }).globalStartMs;
    delete (legacySegment as { globalEndMs?: unknown }).globalEndMs;
    delete (legacySegment as { sessionIndex?: unknown }).sessionIndex;
    mocks.loadDraft.mockResolvedValue({
      segments: [legacySegment],
      summaries: [
        {
          keyPoints: ['legacy'],
          summary: 'Still bounded',
          timestamp: 1,
        },
      ],
      translations: {},
    });

    const response = await POST(
      new Request('http://localhost/api/sessions/session-1/transcript', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ segments: [], summaries: [], translations: {} }),
      }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(mocks.stageArtifacts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        segments: [
          expect.objectContaining({
            startMs: 0,
            globalStartMs: 0,
            endMs: 1_000,
            globalEndMs: 1_000,
            sessionIndex: 0,
          }),
        ],
        summaries: [expect.objectContaining({ keyPoints: ['legacy'] })],
      })
    );
  });

  it('maps ledger quota rejection to a stable 402 without publishing', async () => {
    mocks.stageArtifacts.mockRejectedValueOnce(
      new StoredArtifactQuotaExceededError()
    );

    const response = await POST(request(), { params });

    expect(response.status).toBe(402);
    expect(mocks.sessionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.completePublishes).not.toHaveBeenCalled();
  });

  it('rolls both staged objects back when atomic settlement fails', async () => {
    mocks.settleArtifacts.mockRejectedValueOnce(new Error('settle failed'));

    const response = await POST(request(), { params });

    expect(response.status).toBe(500);
    expect(mocks.rollbackArtifact).toHaveBeenCalledTimes(2);
    expect(mocks.completePublishes).not.toHaveBeenCalled();
  });

  it('preserves live objects when COMMIT succeeded but its acknowledgement was lost', async () => {
    mocks.settleArtifacts.mockRejectedValueOnce(
      new Error('commit acknowledgement lost')
    );
    mocks.sessionFindUnique
      .mockResolvedValueOnce({
        id: 'session-1',
        userId: 'user-1',
        status: 'RECORDING',
        folders: [],
      })
      .mockResolvedValueOnce({
        transcriptPath: 'local:transcripts/staged.json',
        summaryPath: 'local:summaries/staged.json',
      });
    mocks.readbackPublication.mockResolvedValueOnce({
      outcome: 'committed',
      publications: [
        { staged: { reference: 'local:transcripts/staged.json' }, settled: {} },
        { staged: { reference: 'local:summaries/staged.json' }, settled: {} },
      ],
    });

    const response = await POST(request(), { params });

    expect(response.status).toBe(200);
    expect(mocks.rollbackArtifact).not.toHaveBeenCalled();
    expect(mocks.completePublishes).toHaveBeenCalledTimes(1);
  });

  it('preserves staged objects when transaction outcome cannot be proven', async () => {
    mocks.settleArtifacts.mockRejectedValueOnce(new Error('connection lost'));
    mocks.readbackPublication.mockResolvedValueOnce({
      outcome: 'unknown',
      publications: [],
    });

    const response = await POST(request(), { params });

    expect(response.status).toBe(500);
    expect(mocks.rollbackArtifact).not.toHaveBeenCalled();
    expect(mocks.completePublishes).not.toHaveBeenCalled();
  });
});
