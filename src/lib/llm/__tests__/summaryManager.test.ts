import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SummaryManager } from '@/lib/llm/summaryManager';
import type { IncrementalSummaryResult } from '@/types/summary';

function okResult(tag: string): IncrementalSummaryResult {
  return {
    new_key_points: [`${tag}-point`],
    new_definitions: {},
    new_summary: `${tag}-summary`,
    new_questions: [],
    updated_running_context: `${tag}-context`,
  };
}

/** 造一个可以手动 resolve/reject 的 fetch 桩 */
function makeDeferredFetch() {
  const calls: Array<{
    resolve: (value: unknown) => void;
    reject: (err: unknown) => void;
    init: RequestInit;
  }> = [];
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    return new Promise((resolve, reject) => {
      calls.push({ resolve, reject, init });
    });
  });
  return { fetchMock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SummaryManager（M15 reset 代次隔离）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('正常路径：结果写进 state 并触发 onStateUpdate（对照组）', async () => {
    const { fetchMock, calls } = makeDeferredFetch();
    vi.stubGlobal('fetch', fetchMock);

    const onStateUpdate = vi.fn();
    const manager = new SummaryManager({ authToken: 't', onStateUpdate });

    manager.onNewSentence('第一场录音的句子');
    const inflight = manager.triggerIncrementalSummary();
    expect(calls).toHaveLength(1);

    calls[0].resolve({ ok: true, json: async () => okResult('A') });
    await inflight;

    expect(onStateUpdate).toHaveBeenCalledTimes(1);
    expect(manager.currentState.blocks).toHaveLength(1);
    expect(manager.currentState.runningContext).toBe('A-context');
  });

  it('in-flight 期间 reset()：结果不得进 state、不得触发 onStateUpdate（不污染新 session）', async () => {
    const { fetchMock, calls } = makeDeferredFetch();
    vi.stubGlobal('fetch', fetchMock);

    const onStateUpdate = vi.fn();
    const onSummaryError = vi.fn();
    const manager = new SummaryManager({
      authToken: 't',
      onStateUpdate,
      onSummaryError,
    });

    manager.onNewSentence('上一场录音的句子');
    const inflight = manager.triggerIncrementalSummary();
    expect(calls).toHaveLength(1);

    // 用户点「新建录制 / 重置」
    manager.reset();

    // 旧请求这才回来
    calls[0].resolve({ ok: true, json: async () => okResult('STALE') });
    await inflight;

    expect(onStateUpdate).not.toHaveBeenCalled();
    expect(onSummaryError).not.toHaveBeenCalled();
    expect(manager.currentState.blocks).toHaveLength(0);
    expect(manager.currentState.runningContext).toBe('');
  });

  it('reset() 会 abort 在途请求（省掉一次不会被采纳的 LLM 往返）', async () => {
    const { fetchMock, calls } = makeDeferredFetch();
    vi.stubGlobal('fetch', fetchMock);

    const manager = new SummaryManager({ authToken: 't' });
    manager.onNewSentence('句子');
    const inflight = manager.triggerIncrementalSummary();

    const signal = calls[0].init.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    manager.reset();
    expect(signal.aborted).toBe(true);

    calls[0].reject(new Error('aborted'));
    await inflight;
  });

  it('in-flight 期间 reset()：旧请求失败也不得把原文塞回新 session 的 buffer', async () => {
    const { fetchMock, calls } = makeDeferredFetch();
    vi.stubGlobal('fetch', fetchMock);

    const onSummaryError = vi.fn();
    const manager = new SummaryManager({ authToken: 't', onSummaryError });

    manager.onNewSentence('上一场录音的句子');
    const inflight = manager.triggerIncrementalSummary();

    manager.reset();
    calls[0].reject(new Error('network down'));
    await inflight;

    expect(onSummaryError).not.toHaveBeenCalled();
    // buffer 被污染的话，新 session 第一次总结会把上一场的句子一起发出去
    manager.onNewSentence('新一场的句子');
    const next = manager.triggerIncrementalSummary();
    const body = JSON.parse(String(calls[1].init.body)) as {
      newTranscript: string;
    };
    expect(body.newTranscript).toBe('新一场的句子');
    expect(body.newTranscript).not.toContain('上一场');

    calls[1].resolve({ ok: true, json: async () => okResult('NEW') });
    await next;
  });
});

describe('SummaryManager（L41 失败退避）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('失败后进入退避，退避期内不再重发同一份必败请求', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('400 context too long');
    });
    vi.stubGlobal('fetch', fetchMock);

    const onSummaryError = vi.fn();
    const manager = new SummaryManager({ authToken: 't', onSummaryError });

    manager.onNewSentence('一段很长的转录');
    await manager.triggerIncrementalSummary();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onSummaryError).toHaveBeenCalledTimes(1);

    // 失败会把原文放回 buffer；紧接着的触发必须被退避挡住
    await manager.triggerIncrementalSummary();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 退避到期后才放行
    vi.advanceTimersByTime(31_000);
    await manager.triggerIncrementalSummary();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('成功一次即清空退避计数', async () => {
    let shouldFail = true;
    const fetchMock = vi.fn(async () => {
      if (shouldFail) throw new Error('boom');
      return { ok: true, json: async () => okResult('OK') } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new SummaryManager({ authToken: 't' });
    manager.onNewSentence('句子');
    await manager.triggerIncrementalSummary();

    shouldFail = false;
    vi.advanceTimersByTime(31_000);
    await manager.triggerIncrementalSummary();
    expect(manager.currentState.blocks).toHaveLength(1);

    // 成功后紧接着的触发不应再被退避挡住
    manager.onNewSentence('另一句');
    await manager.triggerIncrementalSummary();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
