import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/crypto', () => ({ decrypt: (value: string) => value }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: vi.fn() }));

import {
  downloadTranslateOutput,
  getTranslateJob,
  type TranslateWorkerConfig,
} from '@/lib/translate/workerClient';

const WORKER: TranslateWorkerConfig = {
  id: 'worker-1',
  name: 'worker',
  baseUrl: 'https://worker.example',
  token: 'secret',
  concurrency: 1,
  weight: 1,
  qps: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('translation worker response byte boundaries', () => {
  it('控制面声明超大 Content-Length 时读取前 cancel', async () => {
    let pulled = false;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 }
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'content-length': String(64 * 1024 + 1) },
        })
      )
    );

    await expect(getTranslateJob(WORKER, 'job-1')).rejects.toThrow(
      'worker control response exceeded byte limit'
    );
    expect(pulled).toBe(false);
    expect(canceled).toBe(true);
  });

  it('控制面 chunked 实际超限时 cancel', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1));
      },
      cancel() {
        canceled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(stream, { status: 200 }))
    );

    await expect(getTranslateJob(WORKER, 'job-1')).rejects.toThrow(
      'worker control response exceeded byte limit'
    );
    expect(canceled).toBe(true);
  });

  it('PDF 声明超大时不读取产物 body', async () => {
    let pulled = false;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 }
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-length': String(128 * 1024 * 1024 + 1),
          },
        })
      )
    );

    await expect(
      downloadTranslateOutput(WORKER, 'job-1', 'mono')
    ).rejects.toThrow('worker mono output exceeded byte limit');
    expect(pulled).toBe(false);
    expect(canceled).toBe(true);
  });

  it('合法小 PDF 正常读取', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(pdf, {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        })
      )
    );

    const output = await downloadTranslateOutput(WORKER, 'job-1', 'mono');
    expect(output.data.equals(Buffer.from(pdf))).toBe(true);
    expect(output.contentType).toBe('application/pdf');
  });
});
