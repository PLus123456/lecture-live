import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_TRANSCRIPT_LIMITS } from '@/lib/sessionApi';

const { cloudreveCreateMock } = vi.hoisted(() => ({
  cloudreveCreateMock: vi.fn(),
}));

vi.mock('@/lib/storage/cloudreve', () => ({
  CloudreveStorage: { create: cloudreveCreateMock },
}));
vi.mock('@/lib/storage/cloudreveFileDelete', () => ({
  loadCloudreveContext: vi.fn().mockResolvedValue(null),
  deleteCloudreveFile: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/storage/storedArtifactLedger', () => ({
  STORED_ARTIFACT_TYPE: {
    RECORDING: 'recording',
    ENHANCED_AUDIO: 'enhanced_audio',
    TRANSCRIPT: 'transcript',
    SUMMARY: 'summary',
    REPORT: 'report',
    FULL_TRANSCRIPT: 'full_transcript',
  },
  reserveStoredArtifact: vi.fn(),
  recordReservedStoredArtifactLocation: vi.fn(),
  settleStoredArtifact: vi.fn(),
  settleStoredArtifactInTransaction: vi.fn(),
  rollbackStoredArtifact: vi.fn(),
  markStoredArtifactOrphan: vi.fn(),
  releaseStoredArtifact: vi.fn(),
  findBillableStoredArtifactsByOwner: vi.fn().mockResolvedValue([]),
}));

async function loadModule(cwd: string) {
  vi.resetModules();
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  return import('@/lib/sessionPersistence');
}

describe('session artifact bounded reads (SEC-009)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-bounded-read-'));
    cloudreveCreateMock.mockReset();
    cloudreveCreateMock.mockRejectedValue(new Error('cloudreve not configured'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects an oversized local legacy transcript before reading its body', async () => {
    const mod = await loadModule(tmpDir);
    const transcriptPath = path.join(tmpDir, 'data', 'transcripts', 'sess-1.json');
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    const handle = await fs.open(transcriptPath, 'w');
    await handle.truncate(SESSION_TRANSCRIPT_LIMITS.maxPersistedJsonBytes + 1);
    await handle.close();
    const readFileSpy = vi.spyOn(fs, 'readFile');

    const loaded = await mod.loadSessionTranscriptBundle({
      id: 'sess-1',
      userId: 'user-1',
      recordingPath: null,
      transcriptPath: 'local:transcripts/sess-1.json',
      summaryPath: null,
    });

    expect(loaded).toBeNull();
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('cancels a remote stream as soon as its actual bytes exceed the cap', async () => {
    let pulls = 0;
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([1, 2]));
        if (pulls >= 20) controller.close();
      },
      cancel() {
        cancellations += 1;
      },
    });
    const openDownloadStream = vi.fn(async () => new Response(stream));
    const downloadByRemotePath = vi.fn();
    cloudreveCreateMock.mockResolvedValue({
      openDownloadStream,
      downloadByRemotePath,
    });
    const mod = await loadModule(tmpDir);

    const loaded = await mod.readArtifactFromReference(
      { id: 'sess-1', userId: 'user-1' },
      'transcripts',
      '/user-1/transcripts/sess-1.json',
      { maxBytes: 3 }
    );

    expect(loaded).toBeNull();
    expect(openDownloadStream).toHaveBeenCalledOnce();
    expect(downloadByRemotePath).not.toHaveBeenCalled();
    expect(cancellations).toBe(1);
    expect(pulls).toBeLessThan(20);
  });
});
