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

describe('SummaryManager（审计 #6 块时间范围落在录音时间轴上）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('范围取本批句子的段落时间戳：不含开录前空闲 / 暂停 / LLM 耗时，块与块首尾相接', async () => {
    const { fetchMock, calls } = makeDeferredFetch();
    vi.stubGlobal('fetch', fetchMock);
    // 关掉自动触发（按句数 / 按分钟），只由下面显式触发，便于控制每批内容
    const manager = new SummaryManager({ authToken: 't', triggerSentences: 100, triggerMinutes: 1_000 });

    // manager 在页面挂载时构造；用户 10 分钟后才开录（墙钟与录音时间轴脱节）
    vi.advanceTimersByTime(10 * 60_000);
    manager.onNewSentence('s1', { startMs: 500, endMs: 1_000 });
    manager.onNewSentence('s2', { startMs: 1_500, endMs: 4_000 });
    const first = manager.triggerIncrementalSummary();
    vi.advanceTimersByTime(8_000); // LLM 响应耗时
    calls[0].resolve({ ok: true, json: async () => okResult('A') });
    await first;

    // 暂停 5 分钟后继续；段落时间戳已扣除暂停
    vi.advanceTimersByTime(5 * 60_000);
    manager.onNewSentence('s3', { startMs: 4_200, endMs: 6_000 });
    const second = manager.triggerIncrementalSummary();
    calls[1].resolve({ ok: true, json: async () => okResult('B') });
    await second;

    expect(manager.currentState.blocks.map((b) => b.timeRange)).toEqual([
      { startMs: 0, endMs: 4_000 },
      { startMs: 4_000, endMs: 6_000 },
    ]);
  });

  it('失败重试：放回 buffer 的句子连同时间范围一起并入下一次', async () => {
    let shouldFail = true;
    const fetchMock = vi.fn(async () => {
      if (shouldFail) throw new Error('boom');
      return { ok: true, json: async () => okResult('OK') } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SummaryManager({ authToken: 't' });

    manager.onNewSentence('s1', { startMs: 1_000, endMs: 3_000 });
    await manager.triggerIncrementalSummary();
    manager.onNewSentence('s2', { startMs: 3_500, endMs: 9_000 });

    shouldFail = false;
    vi.advanceTimersByTime(31_000);
    await manager.triggerIncrementalSummary();

    expect(manager.currentState.blocks).toHaveLength(1);
    expect(manager.currentState.blocks[0].timeRange).toEqual({ startMs: 0, endMs: 9_000 });
  });

  it('刷新 / 冷恢复后新建的 manager 接续已有块号、时间与滚动上下文，且不就地改 baseline 对象', async () => {
    const { fetchMock, calls } = makeDeferredFetch();
    vi.stubGlobal('fetch', fetchMock);
    const baselineBlocks = [0, 1].map((i) => ({
      id: `b${i}`,
      blockIndex: i,
      timeRange: { startMs: i * 60_000, endMs: (i + 1) * 60_000 },
      keyPoints: [],
      definitions: {},
      summary: `block-${i}`,
      suggestedQuestions: [],
      frozen: i === 0,
    }));
    const manager = new SummaryManager({
      authToken: 't',
      getBaseline: () => ({ blocks: baselineBlocks, runningContext: 'ctx-before-refresh' }),
    });

    manager.onNewSentence('刷新后的新句子', { startMs: 125_000, endMs: 130_000 });
    const inflight = manager.triggerIncrementalSummary();
    const body = JSON.parse(String(calls[0].init.body)) as { runningContext: string };
    expect(body.runningContext).toBe('ctx-before-refresh');
    calls[0].resolve({ ok: true, json: async () => okResult('C') });
    await inflight;

    const blocks = manager.currentState.blocks;
    expect(blocks).toHaveLength(3);
    expect(blocks[2].blockIndex).toBe(2);
    expect(blocks[2].timeRange).toEqual({ startMs: 120_000, endMs: 130_000 });
    expect(baselineBlocks[1].frozen).toBe(false);
  });

  it('接续来的旧块终点晚于本批（旧版墙钟数据）时不产生倒置范围', async () => {
    const { fetchMock, calls } = makeDeferredFetch();
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SummaryManager({
      authToken: 't',
      getBaseline: () => ({
        blocks: [
          {
            id: 'legacy',
            blockIndex: 0,
            timeRange: { startMs: 0, endMs: 500_000 },
            keyPoints: [],
            definitions: {},
            summary: 'legacy',
            suggestedQuestions: [],
            frozen: false,
          },
        ],
        runningContext: 'ctx',
      }),
    });

    manager.onNewSentence('s', { startMs: 100_000, endMs: 110_000 });
    const inflight = manager.triggerIncrementalSummary();
    calls[0].resolve({ ok: true, json: async () => okResult('D') });
    await inflight;

    expect(manager.currentState.blocks[1].timeRange).toEqual({ startMs: 100_000, endMs: 110_000 });
  });
});
