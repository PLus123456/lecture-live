import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  sessionFindUniqueMock,
  sessionUpdateManyMock,
  mkdirMock,
  rmMock,
  validateContainerMock,
  transcodeMock,
  probeDurationMock,
  uploadSonioxFileMock,
  createTranscriptionMock,
  deleteSonioxFileMock,
  deleteSonioxTranscriptionMock,
  failAttemptMock,
  resolveRegionMock,
} = vi.hoisted(() => ({
  sessionFindUniqueMock: vi.fn(),
  sessionUpdateManyMock: vi.fn(),
  mkdirMock: vi.fn(),
  rmMock: vi.fn(),
  validateContainerMock: vi.fn(),
  transcodeMock: vi.fn(),
  probeDurationMock: vi.fn(),
  uploadSonioxFileMock: vi.fn(),
  createTranscriptionMock: vi.fn(),
  deleteSonioxFileMock: vi.fn(),
  deleteSonioxTranscriptionMock: vi.fn(),
  failAttemptMock: vi.fn(),
  resolveRegionMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { findUnique: sessionFindUniqueMock, updateMany: sessionUpdateManyMock },
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('fs/promises', () => ({
  default: { mkdir: mkdirMock, rm: rmMock },
}));
vi.mock('@/lib/audio/ffmpegTranscode', () => ({
  probeDurationSec: probeDurationMock,
  transcodeToMp3: transcodeMock,
  validateMediaContainer: validateContainerMock,
}));
vi.mock('@/lib/soniox/env', () => ({
  resolveAndPersistTaskRegion: resolveRegionMock,
}));
vi.mock('@/lib/soniox/asyncFile', () => ({
  uploadSonioxFile: uploadSonioxFileMock,
  createSonioxTranscription: createTranscriptionMock,
  deleteSonioxFile: deleteSonioxFileMock,
  deleteSonioxTranscription: deleteSonioxTranscriptionMock,
}));
vi.mock('@/lib/audio/fullTranscribeAdmission', () => ({
  failFullTranscribeAttempt: failAttemptMock,
}));

import {
  processFullTranscribe,
  type FullTranscribeProcessRequest,
} from '@/lib/audio/fullTranscribeProcessor';

const CONFIG = { region: 'eu', restBaseUrl: 'https://x', apiKey: 'k' };
const request: FullTranscribeProcessRequest = {
  sessionId: 's1',
  claimId: 'claim-1',
  input: {
    inputPath: '/recordings/s1.webm',
    workDir: '/tmp/full/s1--claim-1',
    contentType: 'audio/webm',
    sizeBytes: 4096,
    source: 'local',
  },
  authoritativeDurationMs: 120_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionFindUniqueMock.mockResolvedValue({
    id: 's1',
    userId: 'u1',
    sourceLang: 'en',
    targetLang: 'zh',
    sonioxRegion: 'eu',
    fullTranscribeClaimId: 'claim-1',
  });
  sessionUpdateManyMock.mockResolvedValue({ count: 1 });
  mkdirMock.mockResolvedValue(undefined);
  rmMock.mockResolvedValue(undefined);
  validateContainerMock.mockResolvedValue(undefined);
  transcodeMock.mockResolvedValue({
    outputPath: '/tmp/full/s1--claim-1/audio.mp3',
    durationSec: 120,
    outputSize: 1024,
  });
  probeDurationMock.mockResolvedValue(120);
  resolveRegionMock.mockResolvedValue(CONFIG);
  uploadSonioxFileMock.mockResolvedValue({ id: 'file-1' });
  createTranscriptionMock.mockResolvedValue({ id: 'job-1' });
  deleteSonioxFileMock.mockResolvedValue(true);
  deleteSonioxTranscriptionMock.mockResolvedValue(true);
  failAttemptMock.mockResolvedValue(true);
});

describe('processFullTranscribe — claimed path pipeline', () => {
  it('uses the prepared path directly and binds every status CAS to claimId', async () => {
    await expect(processFullTranscribe(request)).resolves.toBeUndefined();

    expect(validateContainerMock).toHaveBeenCalledWith('/recordings/s1.webm');
    expect(transcodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inputPath: '/recordings/s1.webm',
        outputPath: '/tmp/full/s1--claim-1/audio.mp3',
        durationSec: 120,
      })
    );
    expect(sessionUpdateManyMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ fullTranscribeClaimId: 'claim-1' }),
        data: expect.objectContaining({ fullTranscribeStatus: 'transcoding' }),
      })
    );
    expect(sessionUpdateManyMock).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        where: expect.objectContaining({ fullTranscribeClaimId: 'claim-1' }),
        data: expect.objectContaining({
          fullTranscribeStatus: 'transcribing',
          fullSonioxFileId: 'file-1',
          fullSonioxTranscriptionId: 'job-1',
        }),
      })
    );
    expect(rmMock).toHaveBeenCalledWith(request.input.workDir, {
      recursive: true,
      force: true,
    });
  });

  it('stale worker with an old claim performs no media or remote work and cleans only its dir', async () => {
    sessionFindUniqueMock.mockResolvedValueOnce({
      id: 's1',
      fullTranscribeClaimId: 'newer-claim',
    });

    await expect(processFullTranscribe(request)).resolves.toBeUndefined();

    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
    expect(validateContainerMock).not.toHaveBeenCalled();
    expect(transcodeMock).not.toHaveBeenCalled();
    expect(uploadSonioxFileMock).not.toHaveBeenCalled();
    expect(rmMock).toHaveBeenCalledOnce();
  });

  it('transcribing CAS loss deletes both unpersisted Soniox resources in dependency order', async () => {
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(processFullTranscribe(request)).resolves.toBeUndefined();

    expect(deleteSonioxTranscriptionMock).toHaveBeenCalledWith(CONFIG, 'job-1');
    expect(deleteSonioxFileMock).toHaveBeenCalledWith(CONFIG, 'file-1');
    expect(deleteSonioxTranscriptionMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteSonioxFileMock.mock.invocationCallOrder[0]
    );
    expect(failAttemptMock).not.toHaveBeenCalled();
  });

  it('lease loss after transcode stops before Soniox upload', async () => {
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(processFullTranscribe(request)).resolves.toBeUndefined();

    expect(transcodeMock).toHaveBeenCalledOnce();
    expect(uploadSonioxFileMock).not.toHaveBeenCalled();
    expect(createTranscriptionMock).not.toHaveBeenCalled();
    expect(failAttemptMock).not.toHaveBeenCalled();
    expect(rmMock).toHaveBeenCalledOnce();
  });

  it('processing failure marks only this claim failed, releases reservation and cleans temp', async () => {
    transcodeMock.mockRejectedValueOnce(new Error('corrupt media'));
    sessionUpdateManyMock.mockResolvedValueOnce({ count: 1 });

    await expect(processFullTranscribe(request)).resolves.toBeUndefined();

    expect(failAttemptMock).toHaveBeenCalledWith({
      sessionId: 's1',
      claimId: 'claim-1',
      allowedStatuses: ['pending', 'transcoding'],
      error: 'corrupt media',
    });
    expect(rmMock).toHaveBeenCalledOnce();
  });

  it('DB failure after Soniox task creation cleans transcription and file, then releases quota', async () => {
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('db down'));

    await expect(processFullTranscribe(request)).resolves.toBeUndefined();

    expect(deleteSonioxTranscriptionMock).toHaveBeenCalledWith(CONFIG, 'job-1');
    expect(deleteSonioxFileMock).toHaveBeenCalledWith(CONFIG, 'file-1');
    expect(failAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', claimId: 'claim-1' })
    );
  });
});
