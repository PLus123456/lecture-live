import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptSegment } from '@/lib/llm/chatContextBuilder';

// gateway 是真正发请求的入口，整个测试都不该出网。token 估算用真的（字符数为近似）
// 在保证 chunk 不超 250 token 的前提下，每个 segment 限制在 ~200 字符就稳够走 1 chunk/seg。
const callEmbeddingMock = vi.fn<(texts: string[]) => Promise<number[][]>>();

vi.mock('@/lib/llm/gateway', () => ({
  callEmbedding: (texts: string[]) => callEmbeddingMock(texts),
}));

// estimateTokens 用真实实现走得通，但为了让 chunk 切分边界稳定且可预测，
// 在这里 stub 成「字符数」就够覆盖 retrieve 路径。
vi.mock('@/lib/llm/tokenizer', () => ({
  estimateTokens: (text: string) => (text ? text.length : 0),
}));

// logger 不需要真正发，pino + server-only 走默认 mock 即可，不需要单独 mock

import {
  invalidateRagCache,
  invalidateRagCacheForRecordings,
  makeRagRetrieverForRecordings,
} from '@/lib/llm/embedding/transcriptRag';

/**
 * 给每段 transcript 派发一个独特的、可预测的"向量"：
 *   - chunk text 前缀 `[recId] ` 后跟 seg 内容；
 *   - 我们用 chunk text 包含哪个关键词来决定它在 3D 空间里偏向哪个 basis。
 *
 * 维度 4：
 *   axis[0] = "alpha" 命中分数
 *   axis[1] = "beta"  命中分数
 *   axis[2] = "gamma" 命中分数
 *   axis[3] = 常量偏置（避免零向量被 cosine 兜底成 0）
 */
function fakeEmbed(texts: string[]): number[][] {
  return texts.map((text) => {
    const lower = text.toLowerCase();
    return [
      lower.includes('alpha') ? 1 : 0,
      lower.includes('beta') ? 1 : 0,
      lower.includes('gamma') ? 1 : 0,
      0.1,
    ];
  });
}

function makeSegments(words: string[]): TranscriptSegment[] {
  return words.map((text, i) => ({ text, startMs: i * 60_000 }));
}

beforeEach(() => {
  callEmbeddingMock.mockReset();
  callEmbeddingMock.mockImplementation(async (texts) => fakeEmbed(texts));
  // 清空模块级缓存：用任意 recordingId 触发 invalidate 一遍即可，但更稳的做法是
  // 把 cache 里所有可能的 key 都清掉。这里用 invalidateRagCacheForRecordings 命中
  // 测试用的两组合。
  invalidateRagCache('rec-a');
  invalidateRagCache('rec-b');
  invalidateRagCache('rec-c');
  invalidateRagCacheForRecordings(['rec-a', 'rec-b']);
  invalidateRagCacheForRecordings(['rec-b', 'rec-a']);
  invalidateRagCacheForRecordings(['rec-a']);
  invalidateRagCacheForRecordings(['rec-c']);
});

describe('makeRagRetrieverForRecordings', () => {
  it('跨多个 recording 检索并按 cosine score 选 top-K', async () => {
    const loadTranscript = vi.fn<
      (id: string) => Promise<ReadonlyArray<TranscriptSegment>>
    >(async (id) => {
      if (id === 'rec-a') {
        return makeSegments([
          'segment about alpha topic',
          'unrelated filler text one',
          'unrelated filler text two',
        ]);
      }
      if (id === 'rec-b') {
        return makeSegments([
          'unrelated filler text three',
          'segment about beta topic',
          'segment about gamma topic',
        ]);
      }
      return [];
    });

    const retrieve = makeRagRetrieverForRecordings(
      ['rec-b', 'rec-a'], // 故意乱序，确认内部排序
      loadTranscript
    );

    const output = await retrieve('alpha', [], /* maxTokens */ 1000);

    // top-1 必须包含 alpha 段，alpha 段来自 rec-a（应带来源前缀 [rec-a]）
    expect(output).toContain('[rec-a] segment about alpha topic');
    // beta / gamma 段（来自 rec-b）维度向量在 query=alpha 下 cosine=0
    // → 在 score 排序时排到后面；当 picked 还有 token 余量它们会被一起拉进来，
    //   但 alpha 那一行一定在最前（因为按 startMs 排序，rec-a 的 startMs 都 < rec-b）。
    const lines = output.split('\n');
    expect(lines[0]).toMatch(/\[rec-a\] segment about alpha topic/);

    // 时间戳格式正确
    expect(output).toMatch(/^\[\d{2}:\d{2}:\d{2}\] /);

    // loader 对两个 recording 都被调用了
    expect(loadTranscript).toHaveBeenCalledWith('rec-a');
    expect(loadTranscript).toHaveBeenCalledWith('rec-b');
  });

  it('相同 recordingIds 二次调用命中 cache —— loader 与 chunk embed 不再触发', async () => {
    const loadTranscript = vi.fn<
      (id: string) => Promise<ReadonlyArray<TranscriptSegment>>
    >(async (id) => {
      if (id === 'rec-a') {
        return makeSegments(['alpha here', 'filler one']);
      }
      if (id === 'rec-b') {
        return makeSegments(['beta here', 'filler two']);
      }
      return [];
    });

    const retrieve = makeRagRetrieverForRecordings(
      ['rec-a', 'rec-b'],
      loadTranscript
    );

    await retrieve('alpha', [], 1000);
    const callCountAfterFirst = callEmbeddingMock.mock.calls.length;
    const loadCountAfterFirst = loadTranscript.mock.calls.length;

    // 第一次至少有一次 chunk-batch embed + 一次 query embed
    expect(callCountAfterFirst).toBeGreaterThanOrEqual(2);
    expect(loadCountAfterFirst).toBe(2);

    // 第二次：loader 不应该再被调用；callEmbedding 只多了一次（query embed）
    await retrieve('alpha', [], 1000);
    expect(loadTranscript.mock.calls.length).toBe(loadCountAfterFirst);
    expect(callEmbeddingMock.mock.calls.length).toBe(callCountAfterFirst + 1);
  });

  it('recordingIds 顺序不同但内容相同 → 命中同一 cache entry', async () => {
    const loadTranscript = vi.fn<
      (id: string) => Promise<ReadonlyArray<TranscriptSegment>>
    >(async (id) => makeSegments([`${id} content alpha`]));

    const retrieveAB = makeRagRetrieverForRecordings(
      ['rec-a', 'rec-b'],
      loadTranscript
    );
    const retrieveBA = makeRagRetrieverForRecordings(
      ['rec-b', 'rec-a'],
      loadTranscript
    );

    await retrieveAB('alpha', [], 1000);
    const loadsAfterFirst = loadTranscript.mock.calls.length;

    await retrieveBA('alpha', [], 1000);
    // 顺序不同也应命中同一 entry → loader 不应再调用
    expect(loadTranscript.mock.calls.length).toBe(loadsAfterFirst);
  });

  it('空 recordingIds 或空 query 直接短路返回空串，不触发 embedding', async () => {
    const loadTranscript = vi.fn();

    const retrieveEmpty = makeRagRetrieverForRecordings([], loadTranscript);
    expect(await retrieveEmpty('alpha', [], 1000)).toBe('');

    const retrieve = makeRagRetrieverForRecordings(['rec-a'], loadTranscript);
    expect(await retrieve('   ', [], 1000)).toBe('');

    expect(callEmbeddingMock).not.toHaveBeenCalled();
    expect(loadTranscript).not.toHaveBeenCalled();
  });

  it('embedding 抛错 → 返回空串，不向上传播', async () => {
    callEmbeddingMock.mockRejectedValueOnce(new Error('boom'));

    const retrieve = makeRagRetrieverForRecordings(
      ['rec-a'],
      async () => makeSegments(['alpha here'])
    );

    const out = await retrieve('alpha', [], 1000);
    expect(out).toBe('');
  });
});

describe('invalidateRagCache(sessionId) 清掉所有包含该 id 的 multi-entries', () => {
  it('单录音 cache 与 multi cache 都被清空', async () => {
    const loadTranscript = vi.fn(async (id: string) =>
      makeSegments([`${id} alpha`])
    );

    const retrieve = makeRagRetrieverForRecordings(
      ['rec-a', 'rec-b'],
      loadTranscript
    );
    await retrieve('alpha', [], 1000);
    const loadsAfterFirst = loadTranscript.mock.calls.length;

    // 清掉 rec-a → 含 rec-a 的 multi entry 应被一并清掉
    invalidateRagCache('rec-a');

    await retrieve('alpha', [], 1000);
    // loader 应被重新调用（cache miss）
    expect(loadTranscript.mock.calls.length).toBeGreaterThan(loadsAfterFirst);
  });

  it('invalidateRagCacheForRecordings 只清恰好该组合', async () => {
    const loadAB = vi.fn(async (id: string) => makeSegments([`${id} alpha`]));
    const loadAC = vi.fn(async (id: string) => makeSegments([`${id} alpha`]));

    const retrieveAB = makeRagRetrieverForRecordings(['rec-a', 'rec-b'], loadAB);
    const retrieveAC = makeRagRetrieverForRecordings(['rec-a', 'rec-c'], loadAC);

    await retrieveAB('alpha', [], 1000);
    await retrieveAC('alpha', [], 1000);
    const abLoads = loadAB.mock.calls.length;
    const acLoads = loadAC.mock.calls.length;

    // 只清 ['rec-a', 'rec-b']
    invalidateRagCacheForRecordings(['rec-b', 'rec-a']);

    await retrieveAB('alpha', [], 1000);
    await retrieveAC('alpha', [], 1000);

    // AB 应该 miss（loader 再次被调用）
    expect(loadAB.mock.calls.length).toBeGreaterThan(abLoads);
    // AC 应该 hit（loader 不再被调用）
    expect(loadAC.mock.calls.length).toBe(acLoads);
  });
});
