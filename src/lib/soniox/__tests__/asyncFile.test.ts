import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SONIOX_TRANSCRIPT_MAX_RESPONSE_BYTES,
  SONIOX_TRANSCRIPT_MAX_TOKENS,
  SonioxTranscriptPayloadError,
  admitSonioxTranscriptResponse,
  getSonioxTranscript,
  uploadSonioxFile,
} from '@/lib/soniox/asyncFile';
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

describe('Soniox transcript ingress admission', () => {
  const config: SonioxRuntimeConfig = {
    region: 'us',
    apiKey: 'soniox-key',
    restBaseUrl: 'https://api.soniox.test',
    wsBaseUrl: 'wss://stt-rt.soniox.test/transcribe-websocket',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('无 Content-Length 时按实际响应流字节超限即取消，且不 JSON.parse', async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024 + 1);
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunks =
          Math.floor(SONIOX_TRANSCRIPT_MAX_RESPONSE_BYTES / chunk.byteLength) + 1;
        for (let index = 0; index < chunks; index += 1) {
          controller.enqueue(chunk);
        }
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { status: 200 }))
    );

    await expect(getSonioxTranscript(config, 'tr-oversize')).rejects.toThrow(
      /too large/
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('在复制 token 前按数组长度拒绝异常 provider 响应', () => {
    expect(() =>
      admitSonioxTranscriptResponse({
        id: 'tr-1',
        text: '',
        tokens: new Array(SONIOX_TRANSCRIPT_MAX_TOKENS + 1),
      })
    ).toThrow(SonioxTranscriptPayloadError);
  });

  it('合法小 transcript 被规范化通过', () => {
    expect(
      admitSonioxTranscriptResponse({
        id: 'tr-1',
        text: 'hello',
        tokens: [
          {
            text: 'hello',
            start_ms: 0,
            end_ms: 100,
            confidence: 0.9,
            speaker: '1',
          },
        ],
      })
    ).toMatchObject({ id: 'tr-1', tokens: [{ text: 'hello' }] });
  });

  // Soniox 统一翻译 token 格式：原文带 'original'（或语种对外的 'none'），译文带 'translation'
  // + source_language。旧白名单只认 'translation' 且拒绝 source_language，整份 transcript 被拒。
  it('接受统一翻译格式的 original / none / translation 与 source_language', () => {
    const admitted = admitSonioxTranscriptResponse({
      id: 'tr-2',
      text: 'Good morning Guten Morgen Bonjour',
      tokens: [
        { text: 'Good morning', start_ms: 0, end_ms: 400, confidence: 0.9, language: 'en', translation_status: 'original' },
        { text: 'Guten Morgen', start_ms: 0, end_ms: 400, confidence: 0.9, language: 'de', translation_status: 'translation', source_language: 'en' },
        { text: 'Bonjour', start_ms: 500, end_ms: 800, confidence: 0.9, language: 'fr', translation_status: 'none' },
      ],
    });
    expect(admitted.tokens.map((t) => t.translation_status)).toEqual([
      'original',
      'translation',
      'none',
    ]);
    expect(admitted.tokens[1].source_language).toBe('en');
  });

  it('忽略未知字段且不把它们拷进规范化结果', () => {
    const admitted = admitSonioxTranscriptResponse({
      id: 'tr-3',
      text: 'hi',
      future_field: { nested: true },
      tokens: [{ text: 'hi', start_ms: 0, end_ms: 50, confidence: 1, new_token_field: 'x' }],
    });
    expect(admitted).toEqual({
      id: 'tr-3',
      text: 'hi',
      tokens: [{ text: 'hi', start_ms: 0, end_ms: 50, confidence: 1 }],
    });
  });

  it('未文档化的 translation_status 取值仍被拒绝', () => {
    expect(() =>
      admitSonioxTranscriptResponse({
        id: 'tr-4',
        text: 'x',
        tokens: [
          { text: 'x', start_ms: 0, end_ms: 1, confidence: 1, translation_status: 'bogus' },
        ],
      })
    ).toThrow(SonioxTranscriptPayloadError);
  });
});
