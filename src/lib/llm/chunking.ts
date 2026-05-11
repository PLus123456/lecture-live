// Transcript / 长文本切块。
// 用于：① 最终摘要 / 关键词 map-reduce  ② L6 RAG embedding 索引
//
// 策略：先按句子/段落自然边界切，再用 token 预算把相邻片段合并到
// 接近 chunkTargetTokens 的大小。既保留语义边界，又避免块过小导致
// LLM 调用次数爆炸。

import { estimateTokens } from './tokenizer';

export interface Chunk {
  /** 块内容 */
  text: string;
  /** 估算 token 数 */
  tokens: number;
  /** 在原文中的起始字符位置（含），用于映射回 transcript 时间戳 */
  charStart: number;
  /** 在原文中的结束字符位置（不含） */
  charEnd: number;
  /** 块序号（从 0 起） */
  index: number;
}

export interface ChunkOptions {
  /** 单块目标 token 数；超过则切下一块（默认 800） */
  chunkTargetTokens?: number;
  /** 单块上限 token 数；超过强切（默认 chunkTargetTokens × 1.25） */
  chunkMaxTokens?: number;
  /** 块间重叠 token 数（默认 0）。RAG 场景下设 50-100 可保留跨块上下文 */
  overlapTokens?: number;
}

const DEFAULT_TARGET = 800;

// 句子边界：中英文标点。注意 \n\n（段落）优先级高于句号。
const SENTENCE_BOUNDARIES = /([。！？!?]+["」』）)]?\s*|\n{2,}|\.\s+(?=[A-Z]))/g;

/**
 * 把文本按句子拆成原子片段。保留分隔符（句号等），方便后续重组时
 * 不丢标点。返回的每段都是"原文连续子串"，拼起来等于原文。
 */
function splitIntoSentences(text: string): string[] {
  if (!text) return [];

  const result: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  SENTENCE_BOUNDARIES.lastIndex = 0;
  while ((match = SENTENCE_BOUNDARIES.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const sentence = text.slice(lastIndex, end);
    if (sentence) result.push(sentence);
    lastIndex = end;
  }
  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }

  return result.length > 0 ? result : [text];
}

/**
 * 把长文本切成 token 大小接近 chunkTargetTokens 的块。
 *
 * - 先按句子拆原子片段
 * - 累积 token 数接近目标时切块
 * - 单个句子若超过 chunkMaxTokens（罕见），按 token 强切
 * - 可选重叠：每个新块前置上一块尾部 N token 的文本（RAG 场景用）
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const target = options.chunkTargetTokens ?? DEFAULT_TARGET;
  const max = options.chunkMaxTokens ?? Math.round(target * 1.25);
  const overlap = options.overlapTokens ?? 0;

  if (!text) return [];

  const sentences = splitIntoSentences(text);
  const chunks: Chunk[] = [];

  let buffer = '';
  let bufferTokens = 0;
  let bufferStart = 0;
  let cursor = 0;
  let chunkIndex = 0;

  const flush = (endPos: number) => {
    if (!buffer) return;
    chunks.push({
      text: buffer,
      tokens: bufferTokens,
      charStart: bufferStart,
      charEnd: endPos,
      index: chunkIndex++,
    });
    if (overlap > 0 && buffer) {
      // 从尾部按估算字符数取 overlap token 等价的文本作为下一块的引子
      const tailRatio = overlap / Math.max(bufferTokens, 1);
      const tailLen = Math.min(buffer.length, Math.floor(buffer.length * tailRatio));
      buffer = buffer.slice(buffer.length - tailLen);
      bufferTokens = estimateTokens(buffer);
      bufferStart = endPos - buffer.length;
    } else {
      buffer = '';
      bufferTokens = 0;
      bufferStart = endPos;
    }
  };

  for (const sentence of sentences) {
    const sentTokens = estimateTokens(sentence);
    cursor += sentence.length;

    // 单句超过 max：先 flush 当前缓冲，再把这句按字符比例强切
    if (sentTokens > max) {
      flush(cursor - sentence.length);
      const ratio = max / sentTokens;
      const sliceLen = Math.max(1, Math.floor(sentence.length * ratio));
      let pos = 0;
      const sentenceStart = cursor - sentence.length;
      while (pos < sentence.length) {
        const piece = sentence.slice(pos, pos + sliceLen);
        chunks.push({
          text: piece,
          tokens: estimateTokens(piece),
          charStart: sentenceStart + pos,
          charEnd: sentenceStart + pos + piece.length,
          index: chunkIndex++,
        });
        pos += sliceLen;
      }
      bufferStart = cursor;
      continue;
    }

    // 加入当前缓冲会超过目标 → 先 flush
    if (bufferTokens + sentTokens > target && buffer) {
      flush(cursor - sentence.length);
    }

    buffer += sentence;
    bufferTokens += sentTokens;
  }

  flush(cursor);
  return chunks;
}
