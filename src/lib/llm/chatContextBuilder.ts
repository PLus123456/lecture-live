import 'server-only';

import {
  estimateTokens,
  estimateTokensJoined,
  truncateToTokensFromEnd,
} from './tokenizer';
import { buildHistoryCompressionPrompt } from './prompts';
import { logger, serializeError } from '@/lib/logger';

const ctxLogger = logger.child({ component: 'chat-context-builder' });

/**
 * 7 级降级链。详见与用户讨论的设计文档：
 *  L1 默认                — 最近 5 轮 transcript + 全部历史 + 完整 summary
 *  L2 缩窗口（动态 3/4/5） — 选最大且仍能塞下的窗口
 *  L3 最小窗口           — 锁定 3 轮 transcript
 *  L4 压历史             — 3 轮 transcript + 早期历史压成 1 条 system
 *  L5 单轮 + 滚动压       — 1 轮 transcript + 历史持续压缩
 *  L6 Transcript RAG     — embedding 检索 top-K 相关片段
 *  L7 RAG + 压 summary   — L6 + summary 截到 1500 token
 *  EOL                    — 仍超 → 调用方应提示用户新建对话
 */
export const DEGRADATION_MIN_LEVEL = 1;
export const DEGRADATION_MAX_LEVEL = 7;

export type DegradationLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export class ChatContextEOLError extends Error {
  constructor(public readonly breakdown: TokenBreakdown) {
    super('context exceeds budget at all degradation levels (EOL)');
    this.name = 'ChatContextEOLError';
  }
}

export interface TranscriptSegment {
  text: string;
  /** 相对 session 开始时刻的毫秒偏移 */
  startMs: number;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  /** 用户消息发出时 transcript 已录到多长（毫秒）。assistant 消息复用前一条 user 的值 */
  transcriptOffsetMs: number;
}

export interface ChatContextInput {
  /** 历史消息（不含当前用户输入），按时间升序 */
  history: ReadonlyArray<ConversationTurn>;
  /** 当前用户输入文本 */
  userInput: string;
  /** 当前 session 完整 transcript segments（按时间序） */
  transcript: ReadonlyArray<TranscriptSegment>;
  /** session 当前 summary 文本 */
  summary: string;
  /** session 开始时刻偏移（毫秒），用于时间锚点显示 */
  totalTranscriptMs: number;
  /** 上次本会话已降到的最低级别（方案 B：单调降级，不能回升） */
  minLevel: DegradationLevel;
  /** 输入 token 预算，超过则升级 */
  inputBudget: number;
  /** 根据每级降级得到的 transcript/summary 生成最终 chat system prompt */
  buildSystemPrompt: (
    transcriptContext: string,
    summaryContext: string
  ) => string;
  /** 用于压缩历史的 LLM 调用 */
  callLLM: (system: string, user: string) => Promise<string>;
  /** 输出语言（用于压缩 prompt） */
  language: string;
  /**
   * L6 RAG 检索：给一个查询文本，返回 top-K transcript 段落文本（按相关性降序）。
   * 未提供时 L6 会退化为"截尾 transcript 到 1000 token"。
   */
  ragRetrieve?: (
    query: string,
    transcript: ReadonlyArray<TranscriptSegment>,
    maxTokens: number
  ) => Promise<string>;
  /**
   * 可选：从指定降级级别开始构造（用于已知 transcript 过长时直接跳到 L6 RAG）。
   * 若设置，则等价于在 buildChatContext 入口处把 minLevel 提到 max(minLevel, forceMinLevel)。
   * 不影响单调降级不变量。
   */
  forceMinLevel?: DegradationLevel;
  /**
   * 可选：录音的最终 report 文本。若提供，会在 chat system prompt 之外
   * 额外作为一条独立 system 消息固定在所有降级级别（包括 L6/L7），
   * 用于给长录音补全宏观背景。建议 ≤ 2000 token，调用方自行截断。
   *
   * 内部会再做一次 8000 字符 (~2000 token) 的安全截断，并把估算 token 计入
   * breakdown.systemPrompt，保证预算不被撑爆。
   */
  reportText?: string;
  /**
   * 可选：会话附件（文档/文本）抽取后拼好的 system 消息文本。和 reportText 一样
   * 由调用方拼到 messages 头部作为独立 system 段，恒定前置在所有降级级别（含 L6/L7）。
   *
   * 与 reportText 不同，这里**不做**额外截断 —— 调用方（buildAttachmentsSystemMessage）
   * 已对单文件 80K、总量 80K 字符做过截断。本字段只负责把这部分文本的估算 token
   * 计入 breakdown.systemPrompt / total，让降级链感知附件占用、正确收缩窗口，
   * 避免长附件破坏降级不变量、一路反应式重试到 EOL。
   *
   * 注意：传入应是调用方**最终前置的完整字符串**（含其外层 header 包裹），
   * 这样 token 估算才与真实发送量一致。
   */
  attachmentsText?: string;
}

export interface TokenBreakdown {
  systemPrompt: number;
  timeAnchor: number;
  transcript: number;
  summary: number;
  history: number;
  userInput: number;
  total: number;
}

export interface ChatContextOutput {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  level: DegradationLevel;
  breakdown: TokenBreakdown;
  /** 若 input.reportText 存在则同时返回；调用方负责把它拼到 messages 头部作为 system 消息 */
  reportText?: string;
}

/** reportText 安全上限：8000 字符 ≈ 2000 token（cl100k BPE 大致 1:4 字符比） */
export const REPORT_TEXT_MAX_CHARS = 8000;

/** 内部：把 reportText 截到上限。空/未传 → undefined */
function truncateReportText(input: string | undefined): string | undefined {
  if (!input) return undefined;
  if (input.length <= REPORT_TEXT_MAX_CHARS) return input;
  return input.slice(0, REPORT_TEXT_MAX_CHARS);
}

/* ------------------------------------------------------------------ */
/*  时间锚点 system 消息（all-on）                                       */
/* ------------------------------------------------------------------ */

/**
 * 把 ms 偏移格式化为 HH:MM:SS 字符串。
 */
function formatOffset(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * 生成时间锚点 system 消息：告诉 LLM 每条 user message 对应 transcript 的时间点。
 * 即使 transcript 被截了，LLM 也能定位用户在问哪个时段。
 */
function buildTimeAnchor(
  history: ReadonlyArray<ConversationTurn>,
  totalTranscriptMs: number,
  language: string
): string {
  const userTurns = history.filter((t) => t.role === 'user');
  if (userTurns.length === 0) {
    return '';
  }

  const isZh = language.toLowerCase().startsWith('zh');
  const header = isZh
    ? '以下是本次对话的时间脉络（与录音 transcript 对齐）：'
    : 'Time anchors for this conversation (aligned with the recording transcript):';
  const totalLabel = isZh ? '当前 transcript 总时长' : 'Current transcript duration';
  const turnLabel = isZh ? '第' : 'Turn';

  const lines = userTurns.map((turn, idx) => {
    if (isZh) {
      return `- 第 ${idx + 1} 轮用户消息发生在 transcript ${formatOffset(turn.transcriptOffsetMs)}`;
    }
    return `- ${turnLabel} ${idx + 1}: user spoke at ${formatOffset(turn.transcriptOffsetMs)}`;
  });

  return [
    header,
    ...lines,
    `${totalLabel}: ${formatOffset(totalTranscriptMs)}`,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/*  Transcript 按"对话轮窗口"裁剪                                       */
/* ------------------------------------------------------------------ */

/**
 * 把 transcript 按"最近 N 轮对话期间"裁剪。
 *  - 用户对话不足 N 轮：返回全部 transcript（窗口包含整个 session）
 *  - 否则：保留 transcript 中 startMs >= 第 (-N) 条 user 消息的 transcriptOffsetMs 的部分
 */
function transcriptWindowByTurns(
  transcript: ReadonlyArray<TranscriptSegment>,
  history: ReadonlyArray<ConversationTurn>,
  windowTurns: number
): string {
  const userTurns = history.filter((t) => t.role === 'user');
  if (userTurns.length <= windowTurns) {
    return transcript.map((s) => s.text).join(' ');
  }
  const cutoffMs = userTurns[userTurns.length - windowTurns].transcriptOffsetMs;
  return transcript
    .filter((s) => s.startMs >= cutoffMs)
    .map((s) => s.text)
    .join(' ');
}

/* ------------------------------------------------------------------ */
/*  历史压缩（L4+）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 序列化历史消息为可读文本（喂给压缩 prompt）。
 */
function serializeHistory(messages: ReadonlyArray<ConversationTurn>): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'STUDENT' : 'AI'}: ${m.content}`)
    .join('\n\n');
}

/**
 * 压缩历史：保留最近 keepTurns 条原文，把更早的压成一条 system 摘要。
 *
 * 返回 null 表示历史本身就 ≤ keepTurns（无需压缩）。
 */
export async function compressHistory(input: {
  history: ReadonlyArray<ConversationTurn>;
  keepTurns: number;
  callLLM: (system: string, user: string) => Promise<string>;
  language: string;
}): Promise<{
  summarySystemMessage: string;
  recentTurns: ReadonlyArray<ConversationTurn>;
} | null> {
  const { history, keepTurns, callLLM, language } = input;

  // 按 user 消息计数：保留最近 keepTurns 条 user + 它们后续的 assistant
  const userIndices = history
    .map((m, i) => (m.role === 'user' ? i : -1))
    .filter((i) => i >= 0);

  if (userIndices.length <= keepTurns) {
    return null;
  }

  const splitAt = userIndices[userIndices.length - keepTurns];
  const earlyHistory = history.slice(0, splitAt);
  const recentTurns = history.slice(splitAt);

  if (earlyHistory.length === 0) {
    return null;
  }

  try {
    const { system, user } = buildHistoryCompressionPrompt(
      serializeHistory(earlyHistory),
      language
    );
    const summary = await callLLM(system, user);
    return {
      summarySystemMessage: summary.trim(),
      recentTurns,
    };
  } catch (error) {
    ctxLogger.warn(
      {
        earlyHistoryCount: earlyHistory.length,
        keepTurns,
        err: serializeError(error),
      },
      '历史压缩失败，将退化为按 token 截断'
    );
    // 失败兜底：把早期历史按字符截断（不丢但很粗糙）
    const truncated = truncateToTokensFromEnd(
      serializeHistory(earlyHistory),
      500
    );
    return {
      summarySystemMessage: `[Previous conversation summary unavailable, abridged]:\n${truncated}`,
      recentTurns,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  各级降级实现                                                       */
/* ------------------------------------------------------------------ */

interface BuildState {
  buildSystemPrompt: ChatContextInput['buildSystemPrompt'];
  timeAnchor: string;
  transcript: ReadonlyArray<TranscriptSegment>;
  summary: string;
  history: ReadonlyArray<ConversationTurn>;
  userInput: string;
  /** L4+ 用：压缩后的历史（如果已生成） */
  compressedHistory: Awaited<ReturnType<typeof compressHistory>> | null;
  /** L6+ 用：RAG 检索回调 */
  ragRetrieve?: ChatContextInput['ragRetrieve'];
  /** 已截断后的 report 文本；undefined 表示调用方未提供。仅用于 token 预算估算与回传。 */
  reportText?: string;
  /** reportText 的 token 估算（预先算好，避免在 7 级降级循环里重复 encode 8000 字符）。 */
  reportTokens: number;
  /**
   * attachments system 文本的 token 估算（预先算好，避免在 7 级降级循环里重复 encode
   * 最多 80K 字符）。调用方负责把文本本身前置进 messages，这里只计预算。
   */
  attachmentsTokens: number;
}

function assembleOutput(
  level: DegradationLevel,
  state: BuildState,
  transcriptText: string,
  summaryText: string,
  finalHistory: ReadonlyArray<ConversationTurn>,
  compressedHeader?: string
): ChatContextOutput {
  const contextSystemPrompt = state.buildSystemPrompt(
    transcriptText,
    summaryText
  );
  const segments = [contextSystemPrompt];
  if (state.timeAnchor) segments.push(state.timeAnchor);
  if (compressedHeader) {
    segments.push(
      `[Earlier conversation summary]:\n${compressedHeader}`
    );
  }
  const systemPrompt = segments.join('\n\n');

  const messages: ChatContextOutput['messages'] = [
    ...finalHistory.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: state.userInput },
  ];

  const messageTokens =
    finalHistory.reduce((acc, m) => acc + estimateTokens(m.content), 0) +
    estimateTokens(state.userInput);
  // reportText 与 attachmentsText 都由调用方拼到 messages 头部作为独立 system 消息 ——
  // 把它们的 token 估算计进 breakdown.systemPrompt 和 total，让降级判定知道这部分占用。
  // 使用 state 里预先算好的值（buildChatContext 入口各算过一次），避免在降级循环里重复 encode。
  const reportTokens = state.reportTokens;
  const attachmentsTokens = state.attachmentsTokens;
  const breakdown: TokenBreakdown = {
    systemPrompt:
      estimateTokens(state.buildSystemPrompt('', '')) +
      reportTokens +
      attachmentsTokens,
    timeAnchor: estimateTokens(state.timeAnchor),
    transcript: estimateTokens(transcriptText),
    summary: estimateTokens(summaryText),
    history:
      (compressedHeader ? estimateTokens(compressedHeader) : 0) +
      finalHistory.reduce((acc, m) => acc + estimateTokens(m.content), 0),
    userInput: estimateTokens(state.userInput),
    total:
      estimateTokens(systemPrompt) +
      messageTokens +
      reportTokens +
      attachmentsTokens,
  };

  const output: ChatContextOutput = { systemPrompt, messages, level, breakdown };
  if (state.reportText) {
    output.reportText = state.reportText;
  }
  return output;
}

/**
 * 主入口：按降级链组装 chat 上下文。从 minLevel 起步，单调向下尝试，
 * 直到找到一个级别使 estimateTokens(total) ≤ inputBudget。L7 仍超 → 抛 EOL。
 */
export async function buildChatContext(
  input: ChatContextInput
): Promise<ChatContextOutput> {
  const timeAnchor = buildTimeAnchor(
    input.history,
    input.totalTranscriptMs,
    input.language
  );

  const truncatedReport = truncateReportText(input.reportText);

  const state: BuildState = {
    buildSystemPrompt: input.buildSystemPrompt,
    timeAnchor,
    transcript: input.transcript,
    summary: input.summary,
    history: input.history,
    userInput: input.userInput,
    compressedHistory: null,
    ragRetrieve: input.ragRetrieve,
    reportText: truncatedReport,
    reportTokens: truncatedReport ? estimateTokens(truncatedReport) : 0,
    // attachments 文本不在此截断（调用方已限定 80K）；只预估 token 计入预算，
    // 入口算一次，避免 7 级降级循环里反复 encode 最多 80K 字符。
    attachmentsTokens: input.attachmentsText
      ? estimateTokens(input.attachmentsText)
      : 0,
  };

  let lastBreakdown: TokenBreakdown | null = null;

  // forceMinLevel：调用方可强行跳过低级别（典型用于已知 transcript 过长）。
  // 单调降级不变量：实际起点 = max(minLevel, forceMinLevel ?? 1)。
  const startLevel = Math.max(
    input.minLevel,
    input.forceMinLevel ?? DEGRADATION_MIN_LEVEL,
    DEGRADATION_MIN_LEVEL
  );

  for (
    let level = startLevel;
    level <= DEGRADATION_MAX_LEVEL;
    level++
  ) {
    const lv = level as DegradationLevel;

    // L4+ 需要压缩历史：第一次进入 L4 时才做（成本高）
    if (lv >= 4 && !state.compressedHistory) {
      state.compressedHistory = await compressHistory({
        history: input.history,
        // L4: 保留 5 轮；L5+: 保留 3 轮
        keepTurns: lv >= 5 ? 3 : 5,
        callLLM: input.callLLM,
        language: input.language,
      });
    }

    const candidate = await buildAtLevel(lv, state, input.inputBudget);
    lastBreakdown = candidate.breakdown;

    if (candidate.breakdown.total <= input.inputBudget) {
      ctxLogger.debug(
        {
          level: lv,
          breakdown: candidate.breakdown,
          inputBudget: input.inputBudget,
        },
        'chat 上下文组装命中级别'
      );
      return candidate;
    }
  }

  throw new ChatContextEOLError(lastBreakdown ?? makeEmptyBreakdown());
}

function makeEmptyBreakdown(): TokenBreakdown {
  return {
    systemPrompt: 0,
    timeAnchor: 0,
    transcript: 0,
    summary: 0,
    history: 0,
    userInput: 0,
    total: 0,
  };
}

/**
 * 在指定级别下组装一次上下文。注意每级都试图"塞最多"，由调用方判断是否超 budget。
 */
async function buildAtLevel(
  level: DegradationLevel,
  state: BuildState,
  inputBudget: number
): Promise<ChatContextOutput> {
  switch (level) {
    /* L1 默认：最近 5 轮 transcript + 全部历史 + 完整 summary */
    case 1: {
      const transcriptText = transcriptWindowByTurns(
        state.transcript,
        state.history,
        5
      );
      return assembleOutput(
        1,
        { ...state, transcript: makeFakeSegments(transcriptText) },
        transcriptText,
        state.summary,
        state.history
      );
    }

    /* L2 动态窗口：5→4→3 找最大能塞下的 */
    case 2: {
      for (const w of [5, 4, 3] as const) {
        const transcriptText = transcriptWindowByTurns(
          state.transcript,
          state.history,
          w
        );
        const candidate = assembleOutput(
          2,
          { ...state, transcript: makeFakeSegments(transcriptText) },
          transcriptText,
          state.summary,
          state.history
        );
        if (candidate.breakdown.total <= inputBudget) {
          return candidate;
        }
      }
      // 3 轮窗口都塞不下 → 把 3 轮版返回（上层比较仍会超，触发升级到 L3）
      const transcriptText3 = transcriptWindowByTurns(
        state.transcript,
        state.history,
        3
      );
      return assembleOutput(
        2,
        { ...state, transcript: makeFakeSegments(transcriptText3) },
        transcriptText3,
        state.summary,
        state.history
      );
    }

    /* L3 锁 3 轮窗口 */
    case 3: {
      const transcriptText = transcriptWindowByTurns(
        state.transcript,
        state.history,
        3
      );
      return assembleOutput(
        3,
        { ...state, transcript: makeFakeSegments(transcriptText) },
        transcriptText,
        state.summary,
        state.history
      );
    }

    /* L4 3 轮 transcript + 早期历史压缩 */
    case 4: {
      const transcriptText = transcriptWindowByTurns(
        state.transcript,
        state.history,
        3
      );
      const finalHistory = state.compressedHistory?.recentTurns ?? state.history;
      const compressedHeader = state.compressedHistory?.summarySystemMessage;
      return assembleOutput(
        4,
        { ...state, transcript: makeFakeSegments(transcriptText) },
        transcriptText,
        state.summary,
        finalHistory,
        compressedHeader
      );
    }

    /* L5 1 轮 transcript + 滚动压历史 */
    case 5: {
      const transcriptText = transcriptWindowByTurns(
        state.transcript,
        state.history,
        1
      );
      const finalHistory = state.compressedHistory?.recentTurns ?? state.history;
      const compressedHeader = state.compressedHistory?.summarySystemMessage;
      return assembleOutput(
        5,
        { ...state, transcript: makeFakeSegments(transcriptText) },
        transcriptText,
        state.summary,
        finalHistory,
        compressedHeader
      );
    }

    /* L6 Transcript RAG */
    case 6: {
      // 留 50% inputBudget 给 transcript 检索结果，剩下分给 history + summary
      const ragBudget = Math.floor(inputBudget * 0.5);
      let transcriptText = '';
      if (state.ragRetrieve) {
        try {
          transcriptText = await state.ragRetrieve(
            state.userInput,
            state.transcript,
            ragBudget
          );
        } catch (error) {
          ctxLogger.warn(
            { err: serializeError(error) },
            'L6 RAG 检索失败，退化到截尾 transcript'
          );
        }
      }
      if (!transcriptText) {
        // 退化：截 transcript 尾部 1000 token
        transcriptText = truncateToTokensFromEnd(
          state.transcript.map((s) => s.text).join(' '),
          1000
        );
      }
      const finalHistory = state.compressedHistory?.recentTurns ?? state.history;
      const compressedHeader = state.compressedHistory?.summarySystemMessage;
      return assembleOutput(
        6,
        { ...state, transcript: makeFakeSegments(transcriptText) },
        transcriptText,
        state.summary,
        finalHistory,
        compressedHeader
      );
    }

    /* L7 L6 + summary 截到 1500 token */
    case 7: {
      const ragBudget = Math.floor(inputBudget * 0.5);
      let transcriptText = '';
      if (state.ragRetrieve) {
        try {
          transcriptText = await state.ragRetrieve(
            state.userInput,
            state.transcript,
            ragBudget
          );
        } catch (error) {
          ctxLogger.warn(
            { err: serializeError(error) },
            'L7 RAG 检索失败，退化到截尾 transcript'
          );
        }
      }
      if (!transcriptText) {
        transcriptText = truncateToTokensFromEnd(
          state.transcript.map((s) => s.text).join(' '),
          800
        );
      }
      const summaryText = truncateToTokensFromEnd(state.summary, 1500);
      const finalHistory = state.compressedHistory?.recentTurns ?? state.history;
      const compressedHeader = state.compressedHistory?.summarySystemMessage;
      return assembleOutput(
        7,
        {
          ...state,
          transcript: makeFakeSegments(transcriptText),
          summary: summaryText,
        },
        transcriptText,
        summaryText,
        finalHistory,
        compressedHeader
      );
    }
  }
}

// transcript 在内部只用拼成的字符串估算长度，不再需要 segment 结构 —— 用一个壳维持接口一致
function makeFakeSegments(text: string): TranscriptSegment[] {
  return text ? [{ text, startMs: 0 }] : [];
}

/**
 * 估算"原始 transcript + history + user input"的总 token，给调用方判断是否要传 forceMinLevel。
 * 调用方可据此选择直接跳到 L6（典型阈值：> L1 系统预算的 80%）。
 *
 * 不含 summary / system prompt / time anchor / reportText —— 这些都是调用方自己可以单独估算的部分；
 * 这个函数专注在"会随对话规模膨胀且无法压缩"的三大块上。
 *
 * 实现注意：用 estimateTokensJoined 一次性编码（数百 segment 时比逐段累加快一个数量级，
 * 同时避免段间 token 边界估算误差）。
 */
export function estimateRawContextTokens(
  transcript: ReadonlyArray<TranscriptSegment>,
  history: ReadonlyArray<ConversationTurn>,
  userInput: string
): number {
  const parts: string[] = [];
  for (const seg of transcript) if (seg.text) parts.push(seg.text);
  for (const turn of history) if (turn.content) parts.push(turn.content);
  if (userInput) parts.push(userInput);
  return estimateTokensJoined(parts, ' ');
}
