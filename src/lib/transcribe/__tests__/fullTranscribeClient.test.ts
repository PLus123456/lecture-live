import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  triggerFullTranscribe,
  pollFullTranscribeStatus,
  isFullTranscribeInProgress,
  type FullTranscribeStatus,
} from '@/lib/transcribe/fullTranscribeClient';

/**
 * 完整版补全转录客户端封装回归测试。
 * 覆盖：触发端点各返回码（200/402/alreadyRunning）、状态轮询走到终态、退避重试(429/5xx/网络抖动)、
 * abort 立即返回。轮询间隔用极小值避免真实等待。
 */

interface MockResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

function makeResponse(r: MockResponse) {
  return {
    ok: r.ok,
    status: r.status,
    json: async () => r.body,
  } as unknown as Response;
}

/** 依次返回预排响应；网络错误用 'THROW' 触发 fetch reject。 */
function queueFetch(steps: Array<MockResponse | 'THROW'>) {
  let i = 0;
  return vi.fn(async (_url?: string | URL | Request, _init?: RequestInit) => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step === 'THROW') {
      throw new TypeError('network down');
    }
    return makeResponse(step);
  });
}

const POLL_OPTS = { intervalMs: 1, retryDelayMs: 1 };

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isFullTranscribeInProgress', () => {
  it('进行中态为 true，终态/空为 false', () => {
    for (const s of ['pending', 'transcoding', 'transcribing', 'finalizing'] as const) {
      expect(isFullTranscribeInProgress(s)).toBe(true);
    }
    expect(isFullTranscribeInProgress('completed')).toBe(false);
    expect(isFullTranscribeInProgress('failed')).toBe(false);
    expect(isFullTranscribeInProgress(null)).toBe(false);
    expect(isFullTranscribeInProgress(undefined)).toBe(false);
  });
});

describe('triggerFullTranscribe', () => {
  it('200 首次触发：ok=true，透传 status/estimatedMinutes', async () => {
    const fetchMock = queueFetch([
      { ok: true, status: 200, body: { status: 'pending', estimatedMinutes: 12 } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const r = await triggerFullTranscribe('sess-1', 'tok');
    expect(r.ok).toBe(true);
    expect(r.httpStatus).toBe(200);
    expect(r.status).toBe('pending');
    expect(r.estimatedMinutes).toBe(12);
    // POST + Bearer
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe('POST');
  });

  it('402 额度不足：ok=false，带 estimatedMinutes 供提示', async () => {
    vi.stubGlobal(
      'fetch',
      queueFetch([{ ok: false, status: 402, body: { error: 'Insufficient', estimatedMinutes: 30 } }])
    );
    const r = await triggerFullTranscribe('sess-1', 'tok');
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(402);
    expect(r.estimatedMinutes).toBe(30);
  });

  it('已在跑：alreadyRunning 透传', async () => {
    vi.stubGlobal(
      'fetch',
      queueFetch([{ ok: true, status: 200, body: { status: 'transcribing', alreadyRunning: true } }])
    );
    const r = await triggerFullTranscribe('sess-1', 'tok');
    expect(r.alreadyRunning).toBe(true);
    expect(r.status).toBe('transcribing');
  });
});

describe('pollFullTranscribeStatus', () => {
  it('pending → transcribing → completed：回调有序，返回 completed + segmentCount', async () => {
    vi.stubGlobal(
      'fetch',
      queueFetch([
        { ok: true, status: 200, body: { status: 'pending', hasFullTranscript: false } },
        { ok: true, status: 200, body: { status: 'transcribing', hasFullTranscript: false } },
        {
          ok: true,
          status: 200,
          body: { status: 'completed', hasFullTranscript: true, segmentCount: 7 },
        },
      ])
    );
    const seen: FullTranscribeStatus[] = [];
    const r = await pollFullTranscribeStatus('sess-1', 'tok', {
      ...POLL_OPTS,
      onStatusChange: (s) => seen.push(s),
    });

    expect(seen).toEqual(['pending', 'transcribing', 'completed']);
    expect(r.finalStatus).toBe('completed');
    expect(r.hasFullTranscript).toBe(true);
    expect(r.segmentCount).toBe(7);
  });

  it('failed：返回 failed + error', async () => {
    vi.stubGlobal(
      'fetch',
      queueFetch([
        { ok: true, status: 200, body: { status: 'transcribing' } },
        { ok: true, status: 200, body: { status: 'failed', error: 'Soniox transcription failed' } },
      ])
    );
    const r = await pollFullTranscribeStatus('sess-1', 'tok', POLL_OPTS);
    expect(r.finalStatus).toBe('failed');
    expect(r.error).toBe('Soniox transcription failed');
  });

  it('429 限流 + 网络抖动：退避重试不中断，最终收到 completed', async () => {
    const fetchMock = queueFetch([
      { ok: false, status: 429, body: {} }, // 限流：退避重试
      'THROW', // 网络抖动：退避重试
      { ok: false, status: 503, body: {} }, // 5xx：退避重试
      { ok: true, status: 200, body: { status: 'completed', hasFullTranscript: true } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const r = await pollFullTranscribeStatus('sess-1', 'tok', POLL_OPTS);
    expect(r.finalStatus).toBe('completed');
    // 4 次请求都发生了（3 次退避 + 1 次成功）
    expect(fetchMock.mock.calls.length).toBe(4);
  });

  it('致命 4xx（如 404）：立即以 failed 终止', async () => {
    vi.stubGlobal(
      'fetch',
      queueFetch([{ ok: false, status: 404, body: { error: 'Session not found' } }])
    );
    const r = await pollFullTranscribeStatus('sess-1', 'tok', POLL_OPTS);
    expect(r.finalStatus).toBe('failed');
    expect(r.error).toBe('Session not found');
  });

  it('abort：立即返回当前已知状态，不再请求', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchMock = queueFetch([{ ok: true, status: 200, body: { status: 'pending' } }]);
    vi.stubGlobal('fetch', fetchMock);

    const r = await pollFullTranscribeStatus('sess-1', 'tok', {
      ...POLL_OPTS,
      signal: ctrl.signal,
    });
    expect(r.finalStatus).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('status=null（从未触发/被清空）：结束轮询', async () => {
    vi.stubGlobal(
      'fetch',
      queueFetch([{ ok: true, status: 200, body: { status: null, hasFullTranscript: false } }])
    );
    const r = await pollFullTranscribeStatus('sess-1', 'tok', POLL_OPTS);
    expect(r.finalStatus).toBeNull();
    expect(r.hasFullTranscript).toBe(false);
  });
});
