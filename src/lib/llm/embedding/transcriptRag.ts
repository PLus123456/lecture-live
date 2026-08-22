import 'server-only';

import { callEmbedding } from '@/lib/llm/gateway';
import { estimateTokens } from '@/lib/llm/tokenizer';
import type { TranscriptSegment } from '@/lib/llm/chatContextBuilder';
import { logger, serializeError } from '@/lib/logger';

const ragLogger = logger.child({ component: 'transcript-rag' });

/** 切块目标 token 数：~150 token 一块对短查询的语义匹配效果较好 */
const CHUNK_TARGET_TOKENS = 150;
/** 每块上限 token 数 */
const CHUNK_MAX_TOKENS = 250;
/** Session 级 cache 上限（最近使用的 N 个 session） */
const MAX_CACHED_SESSIONS = 10;
/**
 * M18：单个索引最多 embed 多少块。
 *
 * 150 token/块 × 4000 = ~60 万 token（≈150 万字符）的转录，比任何真实讲座（哪怕挂载
 * 十几段录音）都高一个量级；但它把「一次 chat 请求能扇出多少次 embedding 调用」钉死成
 * 常数——此前完全无闸，异常大的 transcript（或被污染的段数据）会在**回答用户之前**
 * 串行打上百次 embedding RTT，用户侧表现为 chat 卡死、成本落平台厂商 key。
 * 触顶按「保留前 N 块」降级（与 chunkText 的 maxChunks 同语义），并打 warn。
 */
const MAX_INDEXED_CHUNKS = 4000;

interface SegmentChunk {
  text: string;
  startMs: number;
  endMs: number;
  tokens: number;
  /** 多录音模式下用于回溯来源；单录音 retriever 留空即可 */
  recordingId?: string;
}

interface RagState {
  /** transcript 总 segment 数（变化时增量补 embed） */
  lastSegmentCount: number;
  /**
   * 单录音模式：transcript 全文字符总长。段数守恒但文本被改写（如某段被重转写/纠正
   * 而段数不变）时 segment count 判据感知不到，这里补一个内容长度判据兜底 ——
   * 长度变即重切重 embed。undefined = 旧 entry 升级前留下（视为需重建）。
   */
  lastContentLength?: number;
  /**
   * 多录音模式：调用方传入的内容签名（各录音 segment 总数之和）。变化即说明某录音
   * 增长/变动 → 触发增量重建。undefined = 调用方未提供（旧行为：集合不变即整体命中）。
   */
  contentSignature?: number;
  chunks: SegmentChunk[];
  vectors: number[][];
  lastUsedAt: number;
}

/**
 * Module-level session cache。同一进程内对同一 sessionId 的重复 RAG 调用复用
 * 已计算的 embeddings；transcript 增长时只 embed 新增 chunk。
 *
 * 局限：进程重启 / 多实例不共享。后续若要持久化，可加 TranscriptEmbedding 表
 * 或通过 IndexedDB 把 vectors 推到客户端缓存。
 */
const sessionCache = new Map<string, RagState>();

/**
 * M18：同一 cache key 的重建去重。
 *
 * 两个并发请求同时判定 needsRebuild 时，旧实现会各自把整份 transcript 全量 embed 一遍
 * （last-write-wins），扇出与成本直接翻倍。这里对「同一 key + 同一内容指纹」的在途重建
 * 做合流：后到者直接 await 前者的 promise。
 *
 * 指纹不同（内容真的变了）时**不合流** —— 那是两份不同的内容，合流会让后者拿到过期索引。
 */
const inflightRebuilds = new Map<
  string,
  { fingerprint: string; promise: Promise<RagState> }
>();

function dedupeRebuild(
  key: string,
  fingerprint: string,
  build: () => Promise<RagState>
): Promise<RagState> {
  const existing = inflightRebuilds.get(key);
  if (existing && existing.fingerprint === fingerprint) {
    return existing.promise;
  }
  const entry: { fingerprint: string; promise: Promise<RagState> } = {
    fingerprint,
    promise: undefined as unknown as Promise<RagState>,
  };
  entry.promise = (async () => {
    try {
      return await build();
    } finally {
      if (inflightRebuilds.get(key) === entry) inflightRebuilds.delete(key);
    }
  })();
  inflightRebuilds.set(key, entry);
  return entry.promise;
}

/** M18：块数触顶时截断 + warn。返回的一定 ≤ MAX_INDEXED_CHUNKS 块。 */
function capIndexedChunks(
  chunks: SegmentChunk[],
  context: Record<string, unknown>
): SegmentChunk[] {
  if (chunks.length <= MAX_INDEXED_CHUNKS) return chunks;
  ragLogger.warn(
    { ...context, totalChunks: chunks.length, cap: MAX_INDEXED_CHUNKS },
    'RAG 索引块数触顶：只索引前 N 块，尾部内容不会被检索到（L6/L7 的召回因此不完整）'
  );
  return chunks.slice(0, MAX_INDEXED_CHUNKS);
}

function evictLRU() {
  if (sessionCache.size <= MAX_CACHED_SESSIONS) return;
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, state] of sessionCache.entries()) {
    if (state.lastUsedAt < oldestTime) {
      oldestTime = state.lastUsedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) sessionCache.delete(oldestKey);
}

/**
 * L2：把「单段本身就超上限」的文本二次切开。
 *
 * 累积式切分只能在段与段之间断，段内断不了 —— 异步上传 / 完整版转录的 converter
 * 完全可能吐出数千字符的单段（长时间无停顿无换人），这种段会原样变成一个巨 chunk：
 * embedding 语义被稀释到检索近乎失效，命中后拼进上下文还会一次性顶爆预算。
 *
 * 切法：用**本段实测的字符/token 比**反推窗口长度（CJK 与拉丁比例差很远，写死常数不稳），
 * 窗口取 CHUNK_TARGET_TOKENS 而非 MAX，留 ~40% 余量吸收比例误差，从而不必对每片重新
 * encode（estimateTokens 是真 BPE，逐片重估会退化成 O(n²)）。
 * 断点优先取窗口末 20% 内的空白（拉丁受益）；CJK 无空白就硬切。
 */
function splitOversizedSegmentText(text: string, tokens: number): string[] {
  if (tokens <= CHUNK_MAX_TOKENS || text.length === 0) return [text];
  const charsPerToken = Math.max(1, text.length / tokens);
  const window = Math.max(1, Math.floor(CHUNK_TARGET_TOKENS * charsPerToken));
  const pieces: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + window);
    if (end < text.length) {
      const minBreak = i + Math.floor(window * 0.8);
      for (let j = end; j > minBreak; j--) {
        if (/\s/.test(text[j - 1])) {
          end = j;
          break;
        }
      }
    }
    pieces.push(text.slice(i, end));
    i = end;
  }
  return pieces;
}

/**
 * 把 transcript segments 按 token 目标累积切成 chunk。
 * 每个 chunk 自然记录 startMs/endMs，方便上层加时间标签。
 */
function chunkSegments(
  segments: ReadonlyArray<TranscriptSegment>
): SegmentChunk[] {
  if (segments.length === 0) return [];

  const chunks: SegmentChunk[] = [];
  let bufferText = '';
  let bufferTokens = 0;
  let bufferStart = segments[0].startMs;
  let bufferEnd = segments[0].startMs;

  const flush = () => {
    if (!bufferText) return;
    chunks.push({
      text: bufferText.trim(),
      startMs: bufferStart,
      endMs: bufferEnd,
      tokens: bufferTokens,
    });
    bufferText = '';
    bufferTokens = 0;
  };

  for (const seg of segments) {
    const segTokens = estimateTokens(seg.text);

    // L2：单段超上限时累积条件救不了它（buffer 空 → `bufferTokens > 0` 不成立，
    // 整段照收后 flush 出一个远超 CHUNK_MAX_TOKENS 的巨块）。先把在手的 buffer 收掉，
    // 再把这一段拆成若干片各自成块。
    if (segTokens > CHUNK_MAX_TOKENS) {
      flush();
      for (const piece of splitOversizedSegmentText(seg.text, segTokens)) {
        const text = piece.trim();
        if (!text) continue;
        chunks.push({
          text,
          // 段内没有更细的时间信息，各片共用该段起点。
          startMs: seg.startMs,
          endMs: seg.startMs,
          tokens: estimateTokens(text),
        });
      }
      bufferEnd = seg.startMs;
      continue;
    }

    if (
      bufferTokens > 0 &&
      (bufferTokens + segTokens > CHUNK_TARGET_TOKENS ||
        bufferTokens + segTokens > CHUNK_MAX_TOKENS)
    ) {
      flush();
    }
    // 新块起点 = 其首段时间。原来只在 flush 分支里更新，超长段路径 flush 后
    // 会把下一块的 startMs 留在旧值上，故统一改成「buffer 为空即取当前段」。
    if (!bufferText) bufferStart = seg.startMs;
    bufferText += (bufferText ? ' ' : '') + seg.text;
    bufferTokens += segTokens;
    bufferEnd = seg.startMs;
  }
  flush();

  return chunks;
}

function cosineSimilarity(a: number[], b: number[]): number {
  // 维度不匹配的诊断由 retrieveTranscriptByEmbedding 在调用前统一处理，
  // 这里只是兜底保护 —— 在热循环里直接 log 会按 chunk 数刷屏。
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 检测「缓存 vectors 是否存在与 query 维度不一致的向量」。
 *
 * 增量重建会对未变 chunk 复用旧向量、只对变动 chunk 用新维度重 embed；切换过
 * embedding 维度（如 1536→1024）后就会得到混合维度的 vectors。若只采样第一个非空
 * 向量（旧实现），当变动 chunk 恰在最前（新维度、与 query 同维）时守卫会误判"维度
 * 一致"，剩下的旧维度 chunk 经 cosineSimilarity 维度不等短路静默得 0 分、检索长期漏
 * 内容且无日志（见 v3 finding U41）。这里改为对整个数组做统一维度断言：只要有任一
 * 非空向量维度 ≠ queryDim（或彼此不一致），即判为需整段重 embed 自愈。
 *
 * 返回首个不一致向量的维度（用于日志）；全部一致或无非空向量时返回 null。
 */
function findMismatchedVectorDim(
  vectors: ReadonlyArray<number[]>,
  queryDim: number
): number | null {
  for (const v of vectors) {
    if (v.length > 0 && v.length !== queryDim) return v.length;
  }
  return null;
}

/**
 * 格式化时间戳为 HH:MM:SS（用于检索结果上的时间标签）。
 */
function formatTimeLabel(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * 对给定 session 的 transcript 做 RAG 检索：
 *  - 增量 chunk + embed（首次或 transcript 增长时）
 *  - query 跑一次 embedding
 *  - cosine 相似度排序，取累计 token 不超 maxTokens 的若干 chunk
 *  - 按时间序拼回（每块前加 [HH:MM:SS] 时间标签）
 *
 * 返回拼接好的文本；若 embedding 调用失败抛错，由调用方（chatContextBuilder L6）
 * 降级到截尾 transcript。
 */
export async function retrieveTranscriptByEmbedding(args: {
  sessionId: string;
  query: string;
  transcript: ReadonlyArray<TranscriptSegment>;
  maxTokens: number;
}): Promise<string> {
  const { sessionId, query, transcript, maxTokens } = args;
  if (transcript.length === 0 || !query.trim()) return '';

  let state = sessionCache.get(sessionId);

  // 内容签名：transcript 全文字符总长。配合 segment 数共同判新鲜度 —— segment 数守恒
  // 但某段被重转写/纠正（文本变、段数不变）时仅靠 segment count 会漏判命中陈旧向量。
  const contentLength = transcript.reduce((acc, seg) => acc + seg.text.length, 0);

  // 增量补块：segment 数或全文长度任一变化时重切（简化处理 —— 实测重切成本远低于 embed）。
  // 旧 entry（升级前无 lastContentLength）一律视为需重建，重建后即带上该字段。
  const needsRebuild =
    !state ||
    state.lastSegmentCount !== transcript.length ||
    state.lastContentLength !== contentLength;

  if (needsRebuild) {
    const prev = state;
    // M18：并发同内容重建合流，避免两个请求各自全量 embed 一遍。
    state = await dedupeRebuild(
      sessionId,
      `${transcript.length}:${contentLength}`,
      async () => {
        const newChunks = capIndexedChunks(chunkSegments(transcript), {
          sessionId,
        });

        // 复用已 embed 的部分：用 (startMs, text) 做 key 匹配
        let existingVectors: number[][] = [];
        if (prev) {
          const oldByKey = new Map(
            prev.chunks.map((c, i) => [`${c.startMs}|${c.text}`, prev.vectors[i]])
          );
          existingVectors = newChunks.map(
            (c) => oldByKey.get(`${c.startMs}|${c.text}`) ?? ([] as number[])
          );
        } else {
          existingVectors = newChunks.map(() => [] as number[]);
        }

        // 哪些 chunk 还没 embed
        const missingIndices = existingVectors
          .map((v, i) => (v.length === 0 ? i : -1))
          .filter((i) => i >= 0);

        if (missingIndices.length > 0) {
          const missingTexts = missingIndices.map((i) => newChunks[i].text);
          const newVectors = await callEmbedding(missingTexts);
          missingIndices.forEach((idx, i) => {
            existingVectors[idx] = newVectors[i];
          });
        }

        ragLogger.debug(
          {
            sessionId,
            totalChunks: newChunks.length,
            newlyEmbedded: missingIndices.length,
          },
          'RAG cache 已更新'
        );

        return {
          lastSegmentCount: transcript.length,
          lastContentLength: contentLength,
          chunks: newChunks,
          vectors: existingVectors,
          lastUsedAt: Date.now(),
        };
      }
    );
    sessionCache.set(sessionId, state);
    evictLRU();
  } else if (state) {
    state.lastUsedAt = Date.now();
  }

  // 此处 state 在 needsRebuild 分支里被赋值过，断言便于 TS 收窄
  let ragState = state!;

  // Query embedding
  const [queryVec] = await callEmbedding([query]);

  // 检测 query vec 与缓存 chunk vec 的维度是否一致：
  // 不一致通常是 admin 切换了不同维度的 embedding 模型（如 1536 → 1024），
  // cache 里仍是旧维度的 vectors（增量重建后可能是新旧混合维度）。一次性 invalidate +
  // 重 embed 整段 transcript。对整个数组做统一维度断言而非只采样第一个非空向量 ——
  // 否则变动 chunk 恰在最前时守卫会漏检混合维度（U41）。
  const mismatchedDim = findMismatchedVectorDim(
    ragState.vectors,
    queryVec.length
  );
  if (mismatchedDim !== null) {
    ragLogger.warn(
      {
        sessionId,
        queryDim: queryVec.length,
        cachedDim: mismatchedDim,
        chunkCount: ragState.chunks.length,
      },
      'Embedding 维度不一致（可能切换了 embedding 模型），自动清空 cache 并重新 embed'
    );
    sessionCache.delete(sessionId);
    const freshVectors = await callEmbedding(ragState.chunks.map((c) => c.text));
    ragState = {
      lastSegmentCount: transcript.length,
      lastContentLength: contentLength,
      chunks: ragState.chunks,
      vectors: freshVectors,
      lastUsedAt: Date.now(),
    };
    sessionCache.set(sessionId, ragState);
  }

  // Cosine 排序
  const scored = ragState.chunks.map((chunk, i) => ({
    chunk,
    score: cosineSimilarity(queryVec, ragState.vectors[i]),
    originalIndex: i,
  }));
  scored.sort((a, b) => b.score - a.score);

  // 取累计 token 不超 maxTokens 的 top-K
  const picked: typeof scored = [];
  let usedTokens = 0;
  for (const item of scored) {
    if (usedTokens + item.chunk.tokens > maxTokens) {
      if (picked.length > 0) break;
      // 一个 chunk 都没塞下：硬塞最相关的那个（即使略超），让上层降级判断
      picked.push(item);
      break;
    }
    picked.push(item);
    usedTokens += item.chunk.tokens;
    if (picked.length >= 16) break; // 上限 K，避免太多碎片
  }

  // 按时间序拼回（不按相似度，便于 LLM 理解叙事流）
  picked.sort((a, b) => a.chunk.startMs - b.chunk.startMs);

  return picked
    .map(
      (item) => `[${formatTimeLabel(item.chunk.startMs)}] ${item.chunk.text}`
    )
    .join('\n');
}

/** multi-recording cache key 前缀；与单录音 sessionId 同 Map 共享空间但绝不冲突 */
const MULTI_KEY_PREFIX = 'multi:';
/** cache key 里「录音集合」与「拼接顺序」两段的分隔符 */
const MULTI_ORDER_SEP = '::';

/**
 * 把一组 recordingIds 规范化为 cache key：`multi:<排序后的集合>::<调用方拼接顺序>`。
 *
 * L42：key 此前**只有集合部分**（顺序无关）。但 chunk 的 startMs 是调用方按
 * 「各录音在本对话里的拼接顺序」累计平移过的全局轴坐标（chat/route.ts 的
 * segmentsByRecording），contentSignature（段数 + 总字符）同样与顺序无关 ——
 * 于是「A 对话按 r1,r2 挂载」与「B 对话按 r2,r1 挂载」共享同一条 entry，
 * 后者命中前者的快照后，检索结果上的 [HH:MM:SS] 时间标签整体错位。
 * 把拼接顺序并进 key，让两种顺序各自成为独立 entry。
 *
 * 集合部分保留在最前面是刻意的：
 *  - `multiKeyContainsRecording` 仍按集合段判断"是否引用了某录音"；
 *  - `invalidateRagCacheForRecordings` 按集合段前缀清掉**所有顺序变体**。
 */
function buildMultiCacheKey(recordingIds: ReadonlyArray<string>): {
  key: string;
  /** 同一集合、所有顺序变体共有的 key 前缀 */
  setPrefix: string;
  /** 去空去重后、保持调用方顺序的 ids */
  ids: string[];
} {
  const ids = Array.from(
    new Set(recordingIds.map((id) => id.trim()).filter(Boolean))
  );
  const setPrefix = `${MULTI_KEY_PREFIX}${[...ids].sort().join('|')}${MULTI_ORDER_SEP}`;
  return { key: `${setPrefix}${ids.join('|')}`, setPrefix, ids };
}

/**
 * 检查一个 cache key 是否是 multi-recording entry 且其 ids 列表包含指定 recordingId。
 * 用于在某录音失效时一并清掉所有引用了该录音的 multi-entries。
 */
function multiKeyContainsRecording(key: string, recordingId: string): boolean {
  if (!key.startsWith(MULTI_KEY_PREFIX)) return false;
  const ids = key
    .slice(MULTI_KEY_PREFIX.length)
    .split(MULTI_ORDER_SEP)[0]
    .split('|');
  return ids.includes(recordingId);
}

/**
 * 从「同一录音集合的其它顺序变体」里回收可复用的向量。
 *
 * 顺序进 key（L42）后，同一组录音的不同顺序会各自建 entry；但 embedding 只取决于
 * chunk 文本（`[recId] …`，不含时间），所以另一顺序算过的向量完全可以直接复用 ——
 * 不这么做的话，一个纯粹的时间标签修复会把整份索引重 embed 一遍（正是 M18 要压的成本）。
 */
function collectSiblingVectors(setPrefix: string): Map<string, number[]> {
  const reusable = new Map<string, number[]>();
  for (const [key, st] of sessionCache.entries()) {
    if (!key.startsWith(setPrefix)) continue;
    st.chunks.forEach((c, i) => {
      const v = st.vectors[i];
      if (v && v.length > 0) reusable.set(c.text, v);
    });
  }
  return reusable;
}

/**
 * 主动清空指定 session 的 RAG cache（如用户"新建对话"或 transcript 被重置时调用）。
 *
 * 同时清掉所有引用了该 sessionId 的 multi-recording entries（cache key 形如 `multi:a|b|c`
 * 含 sessionId 时一并删除），避免上层挂载该录音的全局对话仍读到旧 vectors。
 */
export function invalidateRagCache(sessionId: string): void {
  sessionCache.delete(sessionId);
  for (const key of [...sessionCache.keys()]) {
    if (multiKeyContainsRecording(key, sessionId)) {
      sessionCache.delete(key);
    }
  }
}

/**
 * 清空特定 recordingIds 组合的 multi-recording cache。
 *
 * 与 `invalidateRagCache(singleId)` 不同：这里只清**恰好是这一组录音**的 multi entries
 * （含其所有拼接顺序变体）；其他 multi entries（即使包含其中某个 id）保持不动。用于"用户在
 * conversation 里调整附加录音集合"的场景。
 */
export function invalidateRagCacheForRecordings(
  recordingIds: ReadonlyArray<string>
): void {
  // L42 后同一集合会按拼接顺序分裂成多条 entry —— 全部清掉（前缀匹配），
  // 否则"调整了附加录音集合"只清得掉其中一种顺序。
  const { setPrefix } = buildMultiCacheKey(recordingIds);
  for (const key of [...sessionCache.keys()]) {
    if (key.startsWith(setPrefix)) sessionCache.delete(key);
  }
}

/**
 * 把 retrieveTranscriptByEmbedding 包成 chatContextBuilder.ts 期望的 ragRetrieve 签名。
 * 失败时返回空串，让 chatContextBuilder 退化到截尾 transcript。
 */
export function makeRagRetrieverForSession(sessionId: string) {
  return async (
    query: string,
    transcript: ReadonlyArray<TranscriptSegment>,
    maxTokens: number
  ): Promise<string> => {
    try {
      return await retrieveTranscriptByEmbedding({
        sessionId,
        query,
        transcript,
        maxTokens,
      });
    } catch (error) {
      ragLogger.warn(
        { sessionId, err: serializeError(error) },
        'Embedding 调用失败导致 RAG 不可用，chat L6/L7 已 fallback 到截尾 transcript；如需启用 RAG 检索请到 admin 面板「LLM Providers」配置一个用途为 EMBEDDING 的 OpenAI 兼容 provider 并设为默认'
      );
      return '';
    }
  };
}

/**
 * 多录音 RAG retriever。给定一组 recordingIds + 各自 transcript loader，返回一个
 * 与 `makeRagRetrieverForSession` 同形的闭包：
 *
 *   (query, ignoredTranscript, maxTokens) => Promise<string>
 *
 * 第二个 transcript 参数被忽略（保留只是为了与 chatContextBuilder.ragRetrieve 签名兼容）；
 * 真正的 transcripts 通过 `loadTranscript(recordingId)` 按需异步拉取，懒加载 + 缓存。
 *
 * 输出格式：`[HH:MM:SS] [recId] <text>`，按时间序拼接（每个 chunk 内会预先把 `[recId]`
 * 写入 chunk text，便于 embedding 向量本身就携带来源信号 + 上层可直接 split 出来源）。
 *
 * 缓存：
 *  - key = `multi:${sortedRecordingIds.join('|')}`，与单录音 `sessionCache` 共用同一个
 *    Map，但 multi 前缀绝不会与单录音 sessionId 冲突；
 *  - 命中时按 `contentSignature`（调用方传入的各录音 segment 总数）判断是否增量重建：
 *    签名变 → 重载 + 重切 + 只补 embed 新增/变动 chunk（复用未变 chunk 旧向量）；
 *    签名未变（或未传） → 复用 vectors，不重载（loadTranscript 不被调用）；
 *  - 任一录音消失/重置时由 `invalidateRagCache(recordingId)` 清掉。
 *
 * @param contentSignature 可选内容签名（典型传各录音 segment 数之和）。用于感知"挂载的
 *   录音增长"——不传则退化为旧行为（recordingIds 集合不变即整体命中旧快照）。
 *
 * 失败语义与单录音 retriever 一致：embed 抛错 → 返回 ''，让 chatContextBuilder 退化。
 */
export function makeRagRetrieverForRecordings(
  recordingIds: ReadonlyArray<string>,
  loadTranscript: (
    recordingId: string
  ) => Promise<ReadonlyArray<TranscriptSegment>>,
  contentSignature?: number
): (
  query: string,
  _transcript: ReadonlyArray<TranscriptSegment>,
  maxTokens: number
) => Promise<string> {
  const {
    key: cacheKey,
    setPrefix,
    ids: orderedIds,
  } = buildMultiCacheKey(recordingIds);

  return async (query, _ignored, maxTokens): Promise<string> => {
    if (orderedIds.length === 0 || !query.trim()) return '';

    try {
      let state = sessionCache.get(cacheKey);

      // 增量感知：首次无缓存，或调用方传入的 contentSignature 变化（某录音增长/变动）
      // → 重载 + 重切 + 只补 embed 新增/变动 chunk。签名未变则命中复用、不重载。
      const needsRebuild = !state || state.contentSignature !== contentSignature;

      if (needsRebuild) {
        const prev = state;
        // M18：并发同内容重建合流，避免两个请求各自把整组录音 embed 一遍。
        state = await dedupeRebuild(
          cacheKey,
          String(contentSignature ?? 'none'),
          async () => {
            // 各 recording 的 transcript 互相独立，并行拉取避免串行 N-1 个 RTT
            const transcripts = await Promise.all(
              orderedIds.map((id) => loadTranscript(id))
            );

            const collected: SegmentChunk[] = [];
            for (let i = 0; i < orderedIds.length; i++) {
              const recordingId = orderedIds[i];
              const prefix = `[${recordingId}] `;
              // prefix 写进 chunk text 是为了让 embedding 向量本身带来源信号，
              // 同时上层渲染时可直接 split 出 recordingId
              const prefixTokens = estimateTokens(prefix);
              for (const chunk of chunkSegments(transcripts[i])) {
                collected.push({
                  text: `${prefix}${chunk.text}`,
                  startMs: chunk.startMs,
                  endMs: chunk.endMs,
                  tokens: chunk.tokens + prefixTokens,
                  recordingId,
                });
              }
            }
            const allChunks = capIndexedChunks(collected, {
              cacheKey,
              recordingCount: orderedIds.length,
            });

            // 复用已 embed 的 chunk 向量（key=recordingId|startMs|text），只 embed 新增/变动的，
            // 避免每次增长都整批重 embed（与单录音 retrieveTranscriptByEmbedding 增量逻辑一致）。
            const oldByKey =
              prev && prev.chunks.length > 0
                ? new Map(
                    prev.chunks.map((c, i) => [
                      `${c.recordingId}|${c.startMs}|${c.text}`,
                      prev.vectors[i],
                    ])
                  )
                : null;
            // 同集合、不同拼接顺序的兄弟 entry 也能供货（向量只取决于 chunk 文本）。
            const siblingByText = collectSiblingVectors(setPrefix);
            const vectors: number[][] = allChunks.map(
              (c) =>
                oldByKey?.get(`${c.recordingId}|${c.startMs}|${c.text}`) ??
                siblingByText.get(c.text) ??
                ([] as number[])
            );
            const missingIndices = vectors
              .map((v, i) => (v.length === 0 ? i : -1))
              .filter((i) => i >= 0);
            if (missingIndices.length > 0) {
              const newVectors = await callEmbedding(
                missingIndices.map((i) => allChunks[i].text)
              );
              missingIndices.forEach((idx, i) => {
                vectors[idx] = newVectors[i];
              });
            }

            ragLogger.debug(
              {
                cacheKey,
                recordingCount: orderedIds.length,
                totalChunks: allChunks.length,
                newlyEmbedded: missingIndices.length,
              },
              'multi-recording RAG cache 已建立/增量更新'
            );

            return {
              // recordingIds 集合或拼接顺序变了 cacheKey 就会变 → 走另一个 entry，
              // 所以 state 里不需要单独再记一份 ids
              contentSignature,
              lastSegmentCount: allChunks.length,
              chunks: allChunks,
              vectors,
              lastUsedAt: Date.now(),
            };
          }
        );
        sessionCache.set(cacheKey, state);
        evictLRU();
      } else if (state) {
        state.lastUsedAt = Date.now();
      }

      // needsRebuild 分支必赋值 state；else-if 必进（needsRebuild=false ⟹ state 非空）。
      // 此处 state 必非空，下面这行仅为帮 TS 收窄（理论不可达）。
      if (!state) return '';
      if (state.chunks.length === 0) return '';

      const [queryVec] = await callEmbedding([query]);

      // 维度不一致兜底：admin 切换了 embedding 模型时 cache 里仍是旧维度
      // vectors（增量重建后可能新旧混合维度），需要整批重 embed。对整个数组做统一
      // 维度断言而非只采样第一个非空向量 —— 否则变动 chunk 在最前时会漏检（U41）。
      const mismatchedDim = findMismatchedVectorDim(
        state.vectors,
        queryVec.length
      );
      if (mismatchedDim !== null) {
        ragLogger.warn(
          {
            cacheKey,
            queryDim: queryVec.length,
            cachedDim: mismatchedDim,
            chunkCount: state.chunks.length,
          },
          'Embedding 维度不一致（可能切换了 embedding 模型），自动清空 multi-cache 并重新 embed'
        );
        sessionCache.delete(cacheKey);
        const freshVectors = await callEmbedding(state.chunks.map((c) => c.text));
        state = {
          contentSignature: state.contentSignature,
          lastSegmentCount: state.chunks.length,
          chunks: state.chunks,
          vectors: freshVectors,
          lastUsedAt: Date.now(),
        };
        sessionCache.set(cacheKey, state);
      }

      return formatTopKByScore(state.chunks, state.vectors, queryVec, maxTokens);
    } catch (error) {
      ragLogger.warn(
        { cacheKey, err: serializeError(error) },
        'multi-recording RAG 失败，chat L6/L7 已 fallback 到截尾 transcript；如需启用请到 admin 面板「LLM Providers」配置一个用途为 EMBEDDING 的 OpenAI 兼容 provider 并设为默认'
      );
      return '';
    }
  };
}

/** 单条 chunk 最大数量（每次 retrieval 返回的 top-K 上限），避免太多碎片喂给 LLM */
const RAG_TOP_K_CAP = 16;

/**
 * 给定已 embed 的 chunks + query 向量，按 cosine 降序选 top-K（受 maxTokens 与
 * RAG_TOP_K_CAP 限制），再按时间序拼接为最终输出字符串。
 *
 * 抽出这个 helper 只是为了 makeRagRetrieverForRecordings 内部读起来不那么长 ——
 * 单录音版（retrieveTranscriptByEmbedding）有它自己的增量切块逻辑暂未共用，留作
 * 后续 refactor，避免本 PR 触碰单录音契约。
 */
function formatTopKByScore(
  chunks: ReadonlyArray<SegmentChunk>,
  vectors: ReadonlyArray<number[]>,
  queryVec: number[],
  maxTokens: number
): string {
  const scored = chunks.map((chunk, i) => ({
    chunk,
    score: cosineSimilarity(queryVec, vectors[i]),
  }));
  scored.sort((a, b) => b.score - a.score);

  const picked: typeof scored = [];
  let usedTokens = 0;
  for (const item of scored) {
    if (usedTokens + item.chunk.tokens > maxTokens) {
      if (picked.length > 0) break;
      // 一个都塞不下：硬塞最相关的那个，让上层降级判断
      picked.push(item);
      break;
    }
    picked.push(item);
    usedTokens += item.chunk.tokens;
    if (picked.length >= RAG_TOP_K_CAP) break;
  }

  // 时间序拼回（不按相似度），让 LLM 看到的是叙事流而非按相关性穿插的碎片
  picked.sort((a, b) => a.chunk.startMs - b.chunk.startMs);

  return picked
    .map((item) => `[${formatTimeLabel(item.chunk.startMs)}] ${item.chunk.text}`)
    .join('\n');
}
