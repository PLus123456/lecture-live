import { describe, it, expect, afterEach, vi } from 'vitest';

const { getSiteSettingsMock } = vi.hoisted(() => ({
  getSiteSettingsMock: vi.fn(),
}));

vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: getSiteSettingsMock,
}));

import {
  getEnhanceFleetConfig,
  parseWorkerUrls,
  workerConfigFor,
  pingEnhanceWorker,
  uploadEnhanceInput,
  startEnhanceJob,
  getEnhanceJob,
  downloadEnhanceOutput,
  deleteEnhanceJob,
  EnhanceWorkerError,
} from '@/lib/audio/enhanceWorkerClient';

const CONFIG = { baseUrl: 'https://enhance.test', token: 't'.repeat(32) };

function settings(overrides: Record<string, unknown> = {}) {
  return {
    audio_enhance_enabled: true,
    audio_enhance_worker_url: 'https://enhance.test/',
    audio_enhance_worker_token: 't'.repeat(32),
    audio_enhance_target_lufs: -14,
    audio_enhance_atten_lim_db: 30,
    audio_enhance_concurrency: 1,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  getSiteSettingsMock.mockReset();
});

describe('parseWorkerUrls', () => {
  it('逗号/换行/空白分隔，去尾斜杠去重，保持顺序', () => {
    expect(
      parseWorkerUrls(
        'https://a.test/, https://b.test\nhttps://a.test\n  https://c.test//  '
      )
    ).toEqual(['https://a.test', 'https://b.test', 'https://c.test']);
    expect(parseWorkerUrls('   ')).toEqual([]);
  });
});

describe('getEnhanceFleetConfig', () => {
  it('启用且配置齐备时返回集群配置（URL 规范化）', async () => {
    getSiteSettingsMock.mockResolvedValue(settings());
    const fleet = await getEnhanceFleetConfig();
    expect(fleet).toMatchObject({
      workerUrls: ['https://enhance.test'],
      targetLufs: -14,
      attenLimDb: 30,
      concurrency: 1,
    });
    expect(workerConfigFor(fleet!, fleet!.workerUrls[0])).toEqual({
      baseUrl: 'https://enhance.test',
      token: 't'.repeat(32),
    });
  });

  it('多台配置解析成有序列表', async () => {
    getSiteSettingsMock.mockResolvedValue(
      settings({
        audio_enhance_worker_url: 'https://w1.test, https://w2.test/',
      })
    );
    const fleet = await getEnhanceFleetConfig();
    expect(fleet?.workerUrls).toEqual(['https://w1.test', 'https://w2.test']);
  });

  it('未启用 / 缺 URL / 缺 token 时都返回 null', async () => {
    for (const patch of [
      { audio_enhance_enabled: false },
      { audio_enhance_worker_url: '  ' },
      { audio_enhance_worker_token: '' },
    ]) {
      getSiteSettingsMock.mockResolvedValue(settings(patch));
      expect(await getEnhanceFleetConfig()).toBeNull();
    }
  });
});

describe('worker HTTP 客户端', () => {
  it('ping 带 Bearer 鉴权访问 /healthz', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://enhance.test/healthz');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${CONFIG.token}`);
      return new Response(
        JSON.stringify({ ok: true, engines: { ffmpeg: true, deepFilter: true } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const health = await pingEnhanceWorker(CONFIG);
    expect(health.engines?.deepFilter).toBe(true);
  });

  it('上传输入：PUT 原始字节 + Content-Type 透传', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://enhance.test/jobs/job-1/input');
      expect(init?.method).toBe('PUT');
      const headers = new Headers(init?.headers);
      expect(headers.get('Content-Type')).toBe('audio/webm');
      return new Response(JSON.stringify({ received: 3 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await uploadEnhanceInput(CONFIG, 'job-1', Buffer.from([1, 2, 3]), 'audio/webm');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('start 队列满（429）抛出带状态码的 EnhanceWorkerError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'queue full' }), { status: 429 }))
    );
    await expect(
      startEnhanceJob(CONFIG, 'job-1', { targetLufs: -14, attenLimDb: 30 })
    ).rejects.toMatchObject({ status: 429 });
  });

  it('查询不存在的任务（404）抛 EnhanceWorkerError(404)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'job not found' }), { status: 404 }))
    );
    const err = await getEnhanceJob(CONFIG, 'gone').catch((e) => e);
    expect(err).toBeInstanceOf(EnhanceWorkerError);
    expect(err.status).toBe(404);
  });

  it('下载结果返回字节与 content-type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([9, 9]).buffer, {
            status: 200,
            headers: { 'Content-Type': 'audio/mp4' },
          })
      )
    );
    const { data, contentType } = await downloadEnhanceOutput(CONFIG, 'job-1');
    expect(data.length).toBe(2);
    expect(contentType).toBe('audio/mp4');
  });

  it('删除任务对 404 幂等（不抛）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    await expect(deleteEnhanceJob(CONFIG, 'gone')).resolves.toBeUndefined();
  });
});
