import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadSonioxFile } from '@/lib/soniox/asyncFile';
import type { SonioxRuntimeConfig } from '@/lib/soniox/env';

async function readBody(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('uploadSonioxFile', () => {
  const tempDirs: string[] = [];
  const config: SonioxRuntimeConfig = {
    region: 'us',
    apiKey: 'soniox-key',
    restBaseUrl: 'https://api.soniox.test',
    wsBaseUrl: 'wss://stt-rt.soniox.test/transcribe-websocket',
  };

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
  });

  it('用流式 multipart/form-data 上传本地音频文件', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lecturelive-soniox-'));
    tempDirs.push(tempDir);
    const audioPath = path.join(tempDir, 'audio.mp3');
    await fs.writeFile(audioPath, Buffer.from('fake-audio-bytes'));

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe('https://api.soniox.test/v1/files');
      expect(init?.method).toBe('POST');
      expect((init as RequestInit & { duplex?: string })?.duplex).toBe('half');

      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer soniox-key');
      expect(headers.get('Content-Type')).toMatch(
        /^multipart\/form-data; boundary=lecturelive-soniox-/
      );

      const body = await readBody(init?.body);
      expect(headers.get('Content-Length')).toBe(String(body.length));
      const raw = body.toString('utf8');
      expect(raw).toContain('name="client_reference_id"');
      expect(raw).toContain('session-123');
      expect(raw).toContain('name="file"; filename="session.mp3"');
      expect(raw).toContain('Content-Type: audio/mpeg');
      expect(raw).toContain('fake-audio-bytes');

      return new Response(
        JSON.stringify({
          id: 'file-123',
          filename: 'session.mp3',
          size: 16,
          created_at: '2026-05-14T00:00:00Z',
          client_reference_id: 'session-123',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadSonioxFile(config, audioPath, {
        filename: 'session.mp3',
        clientReferenceId: 'session-123',
      })
    ).resolves.toMatchObject({
      id: 'file-123',
      filename: 'session.mp3',
    });
  });
});
