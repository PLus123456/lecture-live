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
  retrieveTranscriptByEmbedding,
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
  invalidateRagCache('rec-dim');
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

  it('contentSignature 变化（挂载录音增长）→ 增量重建，新内容可被检索到', async () => {
    let segs: TranscriptSegment[] = makeSegments(['alpha one']);
    const loadTranscript = vi.fn(async () => segs);

    // 首次：signature=1（1 段），此时还没有 beta 内容
    const r1 = makeRagRetrieverForRecordings(['rec-a'], loadTranscript, 1);
    const out1 = await r1('beta', [], 1000);
    expect(out1).not.toContain('beta two');
    const loadsAfterFirst = loadTranscript.mock.calls.length;

    // 录音增长到 2 段，signature=2 → 同一 cacheKey 但签名变化应触发重建
    segs = makeSegments(['alpha one', 'beta two']);
    const r2 = makeRagRetrieverForRecordings(['rec-a'], loadTranscript, 2);
    const out2 = await r2('beta', [], 1000);

    // 重建：loader 再次被调用，且新内容能检索到（旧行为下会整体命中旧快照查不到）
    expect(loadTranscript.mock.calls.length).toBeGreaterThan(loadsAfterFirst);
    expect(out2).toContain('beta two');
  });

  it('contentSignature 未变 → 命中复用，loader 不再调用', async () => {
    const loadTranscript = vi.fn(async () => makeSegments(['alpha one']));

    const r1 = makeRagRetrieverForRecordings(['rec-a'], loadTranscript, 7);
    await r1('alpha', [], 1000);
    const loads = loadTranscript.mock.calls.length;

    // 同 signature 的新 retriever（同 cacheKey）→ 不重载
    const r2 = makeRagRetrieverForRecordings(['rec-a'], loadTranscript, 7);
    await r2('alpha', [], 1000);
    expect(loadTranscript.mock.calls.length).toBe(loads);
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

describe('retrieveTranscriptByEmbedding 单录音内容签名（段数守恒也感知文本变化）', () => {
  /** 到目前为止所有 embed 调用（含 query 与 chunk-batch）拼成的全文，便于断言新文本被 embed 过 */
  function allEmbeddedTextsSoFar(): string {
    return callEmbeddingMock.mock.calls.flatMap((args) => args[0]).join('\n');
  }

  it('段数不变但某段文本被改写 → 重切重 embed，新内容可检索到', async () => {
    // 首次：2 段，含 "alpha one"
    const out1 = await retrieveTranscriptByEmbedding({
      sessionId: 'rec-a',
      query: 'beta',
      transcript: makeSegments(['alpha one', 'filler']),
      maxTokens: 1000,
    });
    expect(out1).not.toContain('beta corrected text');

    // 段数仍为 2，但第二段被重转写（文本变、且字符总长变化）→ 内容签名变 → 重建
    const out2 = await retrieveTranscriptByEmbedding({
      sessionId: 'rec-a',
      query: 'beta',
      transcript: makeSegments(['alpha one', 'beta corrected text']),
      maxTokens: 1000,
    });

    // 改写后的段被重 embed（'beta corrected text' 完整短语只可能来自 chunk-batch，
    // query 仅是 'beta' 不含该短语）→ 证明发生了重建；且能检索回来。
    expect(allEmbeddedTextsSoFar()).toContain('beta corrected text');
    expect(out2).toContain('beta corrected text');
  });

  it('transcript 完全不变 → 第二次命中缓存，只发一次 query embed，不重 embed chunk', async () => {
    const transcript = makeSegments(['alpha one', 'filler two']);

    await retrieveTranscriptByEmbedding({
      sessionId: 'rec-b',
      query: 'alpha',
      transcript,
      maxTokens: 1000,
    });
    const callsAfterFirst = callEmbeddingMock.mock.calls.length;

    // 同一份 transcript（段数 + 字符长度都不变）→ 命中缓存：只多一次 query embed
    await retrieveTranscriptByEmbedding({
      sessionId: 'rec-b',
      query: 'alpha',
      transcript,
      maxTokens: 1000,
    });
    expect(callEmbeddingMock.mock.calls.length).toBe(callsAfterFirst + 1);
  });
});

describe('U41 混合维度缓存自愈（变动 chunk 在最前时守卫仍生效）', () => {
  /**
   * 构造场景：admin 切换 embedding 维度（4 → 3），随后用户改写 transcript 第一段。
   *
   *  - 首轮：4 维向量填满 cache（chunk0..N 全 4 维）。
   *  - 改写第一段（段数守恒、字符长度变 → needsRebuild），此时 callEmbedding 已切成 3 维：
   *      · chunk0 的 (startMs|text) key 变、未命中 → 用 3 维重 embed；
   *      · chunk1..N key 未变 → 复用旧 4 维向量；
   *    → vectors[0]=3 维、vectors[1..N]=4 维，「变动 chunk 恰在最前」。
   *  - query 也走 3 维。旧实现只采样第一个非空向量(=vectors[0]=3 维)判定"维度一致"→
   *    守卫失效、旧 4 维 chunk 经 cosineSimilarity 维度不等静默得 0 分、无日志、检索漏内容。
   *  - 修复后：对整个 vectors 数组做统一维度断言 → 检出 4 维残留 → 清缓存整段重 embed 自愈。
   */
  it('切维后改写首段 → 检出混合维度并整段重 embed（而非只采样首个向量）', async () => {
    // 4 维 fake embed（复用 fakeEmbed 语义再补一维偏置到 4）
    const embed4 = (texts: string[]): number[][] =>
      texts.map((t) => {
        const lower = t.toLowerCase();
        return [
          lower.includes('alpha') ? 1 : 0,
          lower.includes('beta') ? 1 : 0,
          lower.includes('gamma') ? 1 : 0,
          0.1,
        ];
      });
    // 3 维 fake embed（切换后的新维度）
    const embed3 = (texts: string[]): number[][] =>
      texts.map((t) => {
        const lower = t.toLowerCase();
        return [
          lower.includes('alpha') ? 1 : 0,
          lower.includes('beta') ? 1 : 0,
          0.1,
        ];
      });

    // 每段填充到 >150「token」(estimateTokens 被 stub 成字符数, CHUNK_TARGET_TOKENS=150)，
    // 保证一段一 chunk —— 否则短段会被合并成单 chunk，构造不出「新旧维度混合、变动 chunk
    // 在最前」的关键序。pad 只加空白，不引入 alpha/beta/gamma 关键词以免污染 embed 命中。
    const pad = ' padding'.repeat(24); // ~192 字符
    const seg0Original = `seg0 alpha topic${pad}`;
    const seg0Rewritten = `seg0 alpha corrected${pad}`; // 首段改写：长度变→needsRebuild，key 变→重 embed
    const seg1 = `seg1 filler content${pad}`;
    const seg2 = `seg2 gamma topic${pad}`;

    // 首轮用 4 维：3 段 → 3 chunk，全 4 维
    callEmbeddingMock.mockImplementation(async (texts) => embed4(texts));
    await retrieveTranscriptByEmbedding({
      sessionId: 'rec-dim',
      query: 'gamma',
      transcript: makeSegments([seg0Original, seg1, seg2]),
      maxTokens: 100_000,
    });

    // 切换到 3 维，并改写第一段（段数不变、长度变）：
    //   chunk0 key 变 → 3 维重 embed 落在 vectors[0]；chunk1/2 key 不变 → 复用旧 4 维。
    //   ⇒ vectors[0]=3 维、vectors[1..2]=4 维，「变动 chunk 恰在最前」。
    callEmbeddingMock.mockImplementation(async (texts) => embed3(texts));
    const callsBeforeSecond = callEmbeddingMock.mock.calls.length;

    const out = await retrieveTranscriptByEmbedding({
      sessionId: 'rec-dim',
      query: 'gamma',
      transcript: makeSegments([seg0Rewritten, seg1, seg2]),
      maxTokens: 100_000,
    });

    // 断言自愈：第二轮里必有一次 batch call 一次性 embed 了全部 chunk（含未变的 seg1/seg2），
    // 这只可能来自维度守卫触发的整段重 embed —— 若守卫失效（旧实现只采样 vectors[0]=3 维、
    // 误判维度一致）则 seg1/seg2 在切维后永不会被再 embed，此断言失败。
    const callsAfterSecond = callEmbeddingMock.mock.calls.slice(callsBeforeSecond);
    const fullRebuildCall = callsAfterSecond.find(
      (args) =>
        args[0].some((t) => t.includes('seg1 filler content')) &&
        args[0].some((t) => t.includes('seg2 gamma topic'))
    );
    expect(fullRebuildCall).toBeDefined();

    // 自愈后全部 chunk 同为 3 维 → gamma query 能正常命中 seg2（不再因维度不等静默得 0）
    expect(out).toContain('seg2 gamma topic');
  });
});
