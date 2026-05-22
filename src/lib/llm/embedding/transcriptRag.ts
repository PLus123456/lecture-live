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

interface SegmentChunk {
  text: string;
  startMs: number;
  endMs: number;
  tokens: number;
}

interface RagState {
  /** transcript 总 segment 数（变化时增量补 embed） */
  lastSegmentCount: number;
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
    if (
      bufferTokens > 0 &&
      (bufferTokens + segTokens > CHUNK_TARGET_TOKENS ||
        bufferTokens + segTokens > CHUNK_MAX_TOKENS)
    ) {
      flush();
      bufferStart = seg.startMs;
    }
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

  // 增量补块：transcript 长度变化时重切（简化处理 —— 实测重切成本远低于 embed）
  const needsRebuild = !state || state.lastSegmentCount !== transcript.length;

  if (needsRebuild) {
    const newChunks = chunkSegments(transcript);

    // 复用已 embed 的部分：用 (startMs, text) 做 key 匹配
    let existingVectors: number[][] = [];
    if (state) {
      const oldByKey = new Map(
        state.chunks.map((c, i) => [`${c.startMs}|${c.text}`, state!.vectors[i]])
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

    state = {
      lastSegmentCount: transcript.length,
      chunks: newChunks,
      vectors: existingVectors,
      lastUsedAt: Date.now(),
    };
    sessionCache.set(sessionId, state);
    evictLRU();

    ragLogger.debug(
      {
        sessionId,
        totalChunks: newChunks.length,
        newlyEmbedded: missingIndices.length,
      },
      'RAG cache 已更新'
    );
  } else if (state) {
    state.lastUsedAt = Date.now();
  }

  // 此处 state 在 needsRebuild 分支里被赋值过，断言便于 TS 收窄
  let ragState = state!;

  // Query embedding
  const [queryVec] = await callEmbedding([query]);

  // 检测 query vec 与缓存 chunk vec 的维度是否一致：
  // 不一致通常是 admin 切换了不同维度的 embedding 模型（如 1536 → 1024），
  // cache 里仍是旧维度的 vectors。一次性 invalidate + 重 embed 整段 transcript。
  const sampleVec = ragState.vectors.find((v) => v.length > 0);
  if (sampleVec && queryVec.length !== sampleVec.length) {
    ragLogger.warn(
      {
        sessionId,
        queryDim: queryVec.length,
        cachedDim: sampleVec.length,
        chunkCount: ragState.chunks.length,
      },
      'Embedding 维度不一致（可能切换了 embedding 模型），自动清空 cache 并重新 embed'
    );
    sessionCache.delete(sessionId);
    const freshVectors = await callEmbedding(ragState.chunks.map((c) => c.text));
    ragState = {
      lastSegmentCount: transcript.length,
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

/**
 * 主动清空指定 session 的 RAG cache（如用户"新建对话"或 transcript 被重置时调用）。
 */
export function invalidateRagCache(sessionId: string): void {
  sessionCache.delete(sessionId);
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
