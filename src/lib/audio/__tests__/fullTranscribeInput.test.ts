import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveLocationMock, createStorageMock, openDownloadStreamMock } = vi.hoisted(
  () => ({
    resolveLocationMock: vi.fn(),
    createStorageMock: vi.fn(),
    openDownloadStreamMock: vi.fn(),
  })
);

vi.mock('@/lib/sessionPersistence', () => ({
  resolveSessionAudioLocation: resolveLocationMock,
}));
vi.mock('@/lib/storage/cloudreve', () => ({
  CloudreveStorage: { create: createStorageMock },
}));

import {
  buildFullTranscribeWorkDir,
  cleanupFullTranscribeWorkDir,
  FullTranscribeInputTooLargeError,
  prepareFullTranscribeInput,
} from '@/lib/audio/fullTranscribeInput';

const session = {
  id: 's-1',
  userId: 'u-1',
  recordingPath: '/u-1/recordings/s-1.webm',
};

let tempRoot = '';

beforeEach(async () => {
  vi.clearAllMocks();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'full-transcribe-input-'));
  createStorageMock.mockResolvedValue({
    openDownloadStream: openDownloadStreamMock,
  });
});

afterEach(async () => {
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
});

function chunkedResponse(chunks: string[], headers?: HeadersInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
        controller.close();
      },
    }),
    { headers }
  );
}

describe('prepareFullTranscribeInput', () => {
  it('returns a local path without reading or copying the recording', async () => {
    const localPath = path.join(tempRoot, 'recording.webm');
    await fs.writeFile(localPath, 'local-audio');
    resolveLocationMock.mockResolvedValueOnce({
      kind: 'local',
      filePath: localPath,
      size: 11,
      contentType: 'audio/webm',
    });

    const prepared = await prepareFullTranscribeInput(session, 'claim-1', {
      tempRoot,
      maxBytes: 20,
    });

    expect(prepared).toMatchObject({
      inputPath: localPath,
      sizeBytes: 11,
      source: 'local',
    });
    expect(openDownloadStreamMock).not.toHaveBeenCalled();
    expect(prepared.workDir).toBe(
      buildFullTranscribeWorkDir('s-1', 'claim-1', tempRoot)
    );
  });

  it('streams a remote recording once into the claim-scoped temp file', async () => {
    resolveLocationMock.mockResolvedValueOnce({
      kind: 'cloudreve',
      remotePath: '/u-1/recordings/s-1.webm',
      userId: 'u-1',
      contentType: 'audio/webm',
    });
    openDownloadStreamMock.mockResolvedValueOnce(chunkedResponse(['abc', 'def']));

    const prepared = await prepareFullTranscribeInput(session, 'claim-1', {
      tempRoot,
      maxBytes: 10,
    });

    expect(openDownloadStreamMock).toHaveBeenCalledTimes(1);
    expect(openDownloadStreamMock).toHaveBeenCalledWith(
      '/u-1/recordings/s-1.webm',
      { expectedUserId: 'u-1' }
    );
    expect(prepared).toMatchObject({ sizeBytes: 6, source: 'cloudreve' });
    await expect(fs.readFile(prepared.inputPath, 'utf8')).resolves.toBe('abcdef');
  });

  it('rejects declared oversize before consuming the body and removes partial state', async () => {
    let pulls = 0;
    resolveLocationMock.mockResolvedValueOnce({
      kind: 'cloudreve',
      remotePath: '/u-1/recordings/s-1.webm',
      userId: 'u-1',
      contentType: 'audio/webm',
    });
    openDownloadStreamMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(Buffer.from('abcdef'));
          },
        }),
        { headers: { 'content-length': '6' } }
      )
    );

    await expect(
      prepareFullTranscribeInput(session, 'claim-1', {
        tempRoot,
        maxBytes: 5,
      })
    ).rejects.toBeInstanceOf(FullTranscribeInputTooLargeError);

    // WHATWG streams may perform one eager pull to fill their internal queue, but the helper
    // rejects from the header before acquiring a reader or writing any bytes to disk.
    expect(pulls).toBeLessThanOrEqual(1);
    await expect(
      fs.stat(buildFullTranscribeWorkDir('s-1', 'claim-1', tempRoot))
    ).rejects.toThrow();
  });

  it('enforces actual chunked bytes when Content-Length is absent and cleans temp', async () => {
    resolveLocationMock.mockResolvedValueOnce({
      kind: 'cloudreve',
      remotePath: '/u-1/recordings/s-1.webm',
      userId: 'u-1',
      contentType: 'audio/webm',
    });
    openDownloadStreamMock.mockResolvedValueOnce(chunkedResponse(['abc', 'def']));

    await expect(
      prepareFullTranscribeInput(session, 'claim-1', {
        tempRoot,
        maxBytes: 5,
      })
    ).rejects.toBeInstanceOf(FullTranscribeInputTooLargeError);

    await expect(
      fs.stat(buildFullTranscribeWorkDir('s-1', 'claim-1', tempRoot))
    ).rejects.toThrow();
  });

  it('removes a partial remote file when the upstream stream fails', async () => {
    resolveLocationMock.mockResolvedValueOnce({
      kind: 'cloudreve',
      remotePath: '/u-1/recordings/s-1.webm',
      userId: 'u-1',
      contentType: 'audio/webm',
    });
    openDownloadStreamMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('abc'));
            controller.error(new Error('upstream reset'));
          },
        })
      )
    );

    await expect(
      prepareFullTranscribeInput(session, 'claim-1', {
        tempRoot,
        maxBytes: 10,
      })
    ).rejects.toThrow('upstream reset');
    await expect(
      fs.stat(buildFullTranscribeWorkDir('s-1', 'claim-1', tempRoot))
    ).rejects.toThrow();
  });

  it('cleanup removes only the selected attempt directory', async () => {
    const oldDir = buildFullTranscribeWorkDir('s-1', 'old-claim', tempRoot);
    const newDir = buildFullTranscribeWorkDir('s-1', 'new-claim', tempRoot);
    await fs.mkdir(oldDir, { recursive: true });
    await fs.mkdir(newDir, { recursive: true });

    await cleanupFullTranscribeWorkDir('s-1', 'old-claim', tempRoot);

    await expect(fs.stat(oldDir)).rejects.toThrow();
    await expect(fs.stat(newDir)).resolves.toBeDefined();
  });
});
