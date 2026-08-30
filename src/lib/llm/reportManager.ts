// src/lib/llm/reportManager.ts
// 录音结束后的报告生成管理器 — 意义评估 + 结构化会议报告

import type {
  SignificanceEvaluation,
  SessionReport,
  SessionReportData,
} from '@/types/report';
import type { SummaryBlock } from '@/types/summary';
import {
  buildSignificanceEvaluationPrompt,
  buildSessionReportPrompt,
  buildChunkSummaryPrompt,
  buildTitleGenerationPrompt,
} from './prompts';
import {
  LLM_LIMITS,
  parseSessionReportResult,
  parseSignificanceEvaluationResult,
  parseTitleGenerationResult,
  countTitleWords,
  type TitleGenerationResult,
} from './security';
import {
  estimateTokens,
  truncateToTokensFromEnd,
  truncateToTokensFromEndUtf8ByteUpperBound,
} from './tokenizer';
import { chunkText, chunkTextWithMeta } from './chunking';
import { logger, serializeError } from '@/lib/logger';

const reportLogger = logger.child({ component: 'report-manager' });

/** Map-reduce 默认并发数（用户敲定 3） */
const MAP_REDUCE_CONCURRENCY = 3;

/**
 * 默认 contextWindow —— 调用方未传时用的保守值。生产环境应该总是从 provider
 * 配置里读出 contextWindow 传进来。
 */
const DEFAULT_CONTEXT_WINDOW = 16384;

/** 各项预留的绝对上限（大窗口下就是它们本身） */
const SYSTEM_PROMPT_RESERVE_TOKENS = 1500;
const SUMMARY_CONTEXT_RESERVE_TOKENS = 9000;
const OUTPUT_RESERVE_TOKENS = 4000;
/**
 * 单份报告允许的最坏供应商工作量。合法的数小时课程通常远低于 128 次调用；
 * 该硬顶主要阻断超大持久化 transcript 被放大成默认 500 次 map 调用。
 */
export const REPORT_MAX_PROVIDER_CALLS = 128;
export const REPORT_MAX_RESERVED_TOKENS = 2_500_000;
const PROMPT_PROTOCOL_TOKEN_OVERHEAD = 64;

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : fallback;
}

/**
 * 计算 final summary 阶段的"transcript 输入预算"。
 *
 * 思路：contextWindow × 0.8（安全冗余）减去 system prompt、summary context、输出预留，
 * 剩下的 token 是 transcript 能塞进去的最大量。
 *
 * L39：三项预留此前写死（1500 / 9000 / 4000），contextWindow=8192 时
 * `6553 - 14500` 为负、却被 `Math.max(2000, …)` 钳回 2000 —— 于是给出一个**根本塞不下**
 * 的预算，叠加 system + summary + output 必然超窗，上游 400，报告永远生成失败且用户只看到
 * "无报告"。改成按 usable 的比例封顶：小窗口下三项预留一起收缩，保证
 * `system + summary + transcript + output ≤ usable` 恒成立。
 *
 * summaryBudget 同时是 summaryContext 的**实际截断长度**（调用方必须照此截断），
 * 否则收缩了预留却照塞 12000 字符的 summary，等于没修。
 *
 * 不变量（本函数的全部意义）：
 *   systemReserve + summaryBudget + transcriptBudget + outputReserve === usable
 * 三项预留各自不超过 usable 的比例份额，所以 transcriptBudget ≥ 0.35 × usable 恒正，
 * 不再需要（也绝不能有）一个会把预算重新撑破窗口的人工下限。
 *
 * 当 contextWindow=200K 时 transcript 预算 ~145K（基本随便塞）；
 * 当 contextWindow=16K 时约 5K（必走 map-reduce）；8K 时约 2.3K 且确实塞得下。
 *
 * 导出仅供单测直接锁住上面那条不变量。
 */
export function computeReportBudgets(contextWindow: number): {
  usable: number;
  systemReserve: number;
  outputReserve: number;
  summaryBudget: number;
  transcriptBudget: number;
} {
  const usable = Math.max(0, Math.floor(contextWindow * 0.8));
  const systemReserve = Math.min(
    SYSTEM_PROMPT_RESERVE_TOKENS,
    Math.floor(usable * 0.15)
  );
  const outputReserve = Math.min(OUTPUT_RESERVE_TOKENS, Math.floor(usable * 0.25));
  const summaryBudget = Math.min(
    SUMMARY_CONTEXT_RESERVE_TOKENS,
    Math.floor(usable * 0.25)
  );
  const transcriptBudget = usable - systemReserve - outputReserve - summaryBudget;
  return { usable, systemReserve, outputReserve, summaryBudget, transcriptBudget };
}

/** 意义评估阈值 — 低于此分数的录音不生成报告 */
const SIGNIFICANCE_THRESHOLD = 0.4;

/** 根据语言格式化时长字符串 */
function formatReportDuration(hours: number, mins: number, language: string): string {
  const lang = language.toLowerCase().slice(0, 2);
  if (lang === 'zh') return hours > 0 ? `${hours}小时${mins}分钟` : `${mins}分钟`;
  if (lang === 'ja') return hours > 0 ? `${hours}時間${mins}分` : `${mins}分`;
  if (lang === 'ko') return hours > 0 ? `${hours}시간 ${mins}분` : `${mins}분`;
  return hours > 0 ? `${hours}h ${mins}min` : `${mins} min`;
}

/** 最短有效转录文本长度（字符数）— 过短的直接跳过 */
const MIN_TRANSCRIPT_LENGTH = 50;

export interface SessionReportWorkPlan {
  providerCalls: number;
  reservedTokens: number;
  chunkCount: number;
  usesMapReduce: boolean;
}

export class SessionReportBudgetExceededError extends Error {
  constructor(readonly plan: SessionReportWorkPlan) {
    super(
      `report generation exceeds budget (${plan.providerCalls} calls, ${plan.reservedTokens} reserved tokens)`
    );
    this.name = 'SessionReportBudgetExceededError';
  }
}

export interface PlanReportWorkOptions {
  transcript: string;
  sessionTitle: string;
  courseName: string;
  durationMs: number;
  date: string;
  summaryBlocks: SummaryBlock[];
  language: string;
  contextWindow?: number;
  /** 实际 gateway 请求会使用的 max_tokens；每次调用都按该最坏输出量预留。 */
  maxOutputTokens?: number;
}

function buildSummaryContext(summaryBlocks: SummaryBlock[]): string {
  return summaryBlocks
    .map((block) => {
      const parts = [block.summary];
      if (block.keyPoints.length > 0) {
        parts.push('Key points: ' + block.keyPoints.join('; '));
      }
      return parts.join(' | ');
    })
    .join('\n')
    .slice(0, LLM_LIMITS.reportSummaryContext);
}

/**
 * 用 UTF-8 字节数作为输入 token 的保守上界。主流 BPE 的单个 token 至少消费一个字节；
 * 再加固定协议开销，避免只按字符/某一家 tokenizer 低估供应商实际计费。
 */
function promptTokenUpperBound(system: string, user: string): number {
  return (
    new TextEncoder().encode(system).byteLength +
    new TextEncoder().encode(user).byteLength +
    PROMPT_PROTOCOL_TOKEN_OVERHEAD
  );
}

/**
 * 在首个供应商调用前计算整次 significance + map/reduce 的最坏工作量。
 * 这是纯函数；调用方必须先 assertSessionReportWorkWithinBudget，再取得跨实例单飞 claim。
 */
export function planSessionReportWork(
  options: PlanReportWorkOptions
): SessionReportWorkPlan {
  const contextWindow = positiveIntegerOrDefault(
    options.contextWindow,
    DEFAULT_CONTEXT_WINDOW
  );
  const maxOutputTokens = positiveIntegerOrDefault(options.maxOutputTokens, 4096);

  if (options.transcript.trim().length < MIN_TRANSCRIPT_LENGTH) {
    return {
      providerCalls: 0,
      reservedTokens: 0,
      chunkCount: 0,
      usesMapReduce: false,
    };
  }

  const significancePrompt = buildSignificanceEvaluationPrompt(
    options.transcript,
    options.durationMs,
    options.language
  );
  let providerCalls = 1;
  let reservedTokens =
    promptTokenUpperBound(significancePrompt.system, significancePrompt.user) +
    maxOutputTokens;

  const { transcriptBudget: inputBudget } = computeReportBudgets(contextWindow);
  const transcriptTokens = estimateTokens(options.transcript);
  const summaryContext = buildSummaryContext(options.summaryBlocks);
  let chunkCount = 0;
  let usesMapReduce = false;

  if (transcriptTokens > inputBudget) {
    usesMapReduce = true;
    const chunks = chunkText(options.transcript, { chunkTargetTokens: 800 });
    chunkCount = chunks.length;
    providerCalls += chunks.length;
    for (const chunk of chunks) {
      const prompt = buildChunkSummaryPrompt(
        chunk.text,
        chunk.index,
        chunks.length,
        options.language
      );
      reservedTokens +=
        promptTokenUpperBound(prompt.system, prompt.user) + maxOutputTokens;
    }

    // map 输出最终会在 reportManager 中由 truncateToTokensFromEnd 截到 inputBudget。
    // 按该函数的确定 UTF-8 字节上界全额预留，再叠加不含 transcript 的固定 prompt。
    const finalPrompt = buildSessionReportPrompt(
      '',
      options.sessionTitle,
      options.courseName,
      options.durationMs,
      options.date,
      summaryContext,
      options.language
    );
    reservedTokens +=
      promptTokenUpperBound(finalPrompt.system, finalPrompt.user) +
      truncateToTokensFromEndUtf8ByteUpperBound(inputBudget) +
      maxOutputTokens;
    providerCalls += 1;
  } else {
    const finalPrompt = buildSessionReportPrompt(
      options.transcript,
      options.sessionTitle,
      options.courseName,
      options.durationMs,
      options.date,
      summaryContext,
      options.language
    );
    reservedTokens +=
      promptTokenUpperBound(finalPrompt.system, finalPrompt.user) + maxOutputTokens;
    providerCalls += 1;
  }

  return {
    providerCalls,
    reservedTokens,
    chunkCount,
    usesMapReduce,
  };
}

export function assertSessionReportWorkWithinBudget(
  plan: SessionReportWorkPlan
): void {
  if (
    !Number.isSafeInteger(plan.providerCalls) ||
    plan.providerCalls < 0 ||
    !Number.isSafeInteger(plan.reservedTokens) ||
    plan.reservedTokens < 0 ||
    !Number.isSafeInteger(plan.chunkCount) ||
    plan.chunkCount < 0 ||
    plan.providerCalls > REPORT_MAX_PROVIDER_CALLS ||
    plan.reservedTokens > REPORT_MAX_RESERVED_TOKENS
  ) {
    throw new SessionReportBudgetExceededError(plan);
  }
}

/** M17：转录被截断时写进报告 overview 的声明（中英双语按 language 选） */
function buildTruncationNotice(
  coveredPct: number | null,
  language: string
): string {
  const isZh = language.toLowerCase().slice(0, 2) === 'zh';
  if (coveredPct === null) {
    return isZh
      ? '[⚠️ 本次转录过长，报告仅基于其中一部分内容生成，尾段未被覆盖。]'
      : '[⚠️ The transcript was too long; this report covers only part of it and omits the tail.]';
  }
  return isZh
    ? `[⚠️ 本次转录过长，报告仅覆盖约前 ${coveredPct}% 的内容，其余部分未参与生成。]`
    : `[⚠️ The transcript was too long; this report covers only about the first ${coveredPct}% of it.]`;
}

interface GenerateReportOptions {
  sessionId: string;
  transcript: string;
  sessionTitle: string;
  courseName: string;
  durationMs: number;
  date: string;
  summaryBlocks: SummaryBlock[];
  language: string;
  callLLM: (system: string, user: string) => Promise<string>;
  /**
   * 当前 FINAL_SUMMARY 模型的上下文窗口（token）。调用方应从 provider 配置
   * 读出 contextWindow 传入。未传则用 DEFAULT_CONTEXT_WINDOW 保守估算 ——
   * 这会导致长 transcript 总是走 map-reduce（更多 LLM 调用，但保证不爆）。
   */
  contextWindow?: number;
}

/**
 * 生成会话报告的完整流程：
 * 1. 检查转录文本是否足够长
 * 2. 调用 LLM 评估录音意义
 * 3. 如果有意义，生成结构化会议报告
 */
export async function generateSessionReport(
  options: GenerateReportOptions
): Promise<SessionReportData> {
  const {
    transcript,
    sessionTitle,
    courseName,
    durationMs,
    date,
    summaryBlocks,
    language,
    callLLM,
    contextWindow: rawContextWindow,
  } = options;
  const contextWindow = positiveIntegerOrDefault(
    rawContextWindow,
    DEFAULT_CONTEXT_WINDOW
  );

  // 快速检查：转录文本过短直接跳过
  if (transcript.trim().length < MIN_TRANSCRIPT_LENGTH) {
    return {
      significance: {
        score: 0,
        reason: '转录文本过短，无法生成有意义的报告',
        isWorthSummarizing: false,
      },
      report: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // 步骤 1: 意义评估
  const significance = await evaluateSignificance(
    transcript,
    durationMs,
    language,
    callLLM
  );

  if (!significance.isWorthSummarizing) {
    return {
      significance,
      report: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // 步骤 2: 生成结构化报告
  const summaryContext = buildSummaryContext(summaryBlocks);

  const report = await generateReport(
    transcript,
    sessionTitle,
    courseName,
    durationMs,
    date,
    summaryContext,
    language,
    callLLM,
    contextWindow
  );

  return {
    significance,
    report,
    generatedAt: new Date().toISOString(),
  };
}

/** 评估录音内容的意义 */
async function evaluateSignificance(
  transcript: string,
  durationMs: number,
  language: string,
  callLLM: (system: string, user: string) => Promise<string>
): Promise<SignificanceEvaluation> {
  try {
    const { system, user } = buildSignificanceEvaluationPrompt(
      transcript,
      durationMs,
      language
    );
    const result = await callLLM(system, user);
    return parseSignificanceEvaluationResult(result, SIGNIFICANCE_THRESHOLD);
  } catch (error) {
    reportLogger.error(
      { err: serializeError(error) },
      '意义评估失败，默认生成报告'
    );
    // 评估失败时默认认为值得生成报告（宁可多生成，不漏掉）
    return {
      score: 0.5,
      reason: '意义评估调用失败，默认生成报告',
      isWorthSummarizing: true,
    };
  }
}

/**
 * Map 阶段：每段单独跑 LLM 抽取事实清单（JSON）。
 * 限制并发避免一次性把上游 quota 打爆。
 */
async function runMapStage(
  chunks: ReadonlyArray<{ text: string; index: number }>,
  totalChunks: number,
  language: string,
  callLLM: (system: string, user: string) => Promise<string>
): Promise<string[]> {
  const results: (string | null)[] = new Array(chunks.length).fill(null);

  // 简易并发池：每次最多 MAP_REDUCE_CONCURRENCY 个 in-flight
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < chunks.length) {
      const myIndex = cursor++;
      const chunk = chunks[myIndex];
      try {
        const { system, user } = buildChunkSummaryPrompt(
          chunk.text,
          chunk.index,
          totalChunks,
          language
        );
        const raw = await callLLM(system, user);
        results[myIndex] = raw.trim();
      } catch (error) {
        reportLogger.warn(
          {
            chunkIndex: chunk.index,
            totalChunks,
            err: serializeError(error),
          },
          '段摘要 LLM 调用失败，该段将以空内容继续'
        );
        // 不抛 —— 一段失败不该杀掉整个报告生成；返回空 JSON，reduce 阶段自然降级。
        results[myIndex] = '{"facts":["[此段摘要生成失败]"]}';
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(MAP_REDUCE_CONCURRENCY, chunks.length) },
    () => worker()
  );
  await Promise.all(workers);

  return results.map((r) => r ?? '{}');
}

/**
 * Reduce 阶段：把所有段摘要 JSON 拼成一段文本，作为"伪 transcript"
 * 喂给 buildSessionReportPrompt。
 */
function buildReducedTranscript(chunkSummariesJson: ReadonlyArray<string>): string {
  return chunkSummariesJson
    .map((raw, i) => `[CHUNK ${i + 1}]\n${raw}`)
    .join('\n\n');
}

/** 生成结构化会议报告（含 map-reduce 长 transcript 处理） */
async function generateReport(
  transcript: string,
  sessionTitle: string,
  courseName: string,
  durationMs: number,
  date: string,
  summaryContext: string,
  language: string,
  callLLM: (system: string, user: string) => Promise<string>,
  contextWindow: number
): Promise<SessionReport | null> {
  try {
    const { transcriptBudget: inputBudget, summaryBudget } =
      computeReportBudgets(contextWindow);
    const transcriptTokens = estimateTokens(transcript);
    // L39：summaryContext 也必须按预算截断 —— 小窗口下预留被按比例收缩，
    // 若照塞 12000 字符的摘要，收缩预留就等于白做。
    const boundedSummaryContext = truncateToTokensFromEnd(
      summaryContext,
      summaryBudget
    );

    let finalTranscript = transcript;
    // M17：切块触顶会**静默丢弃尾段**，用它带到日志与报告产物里。
    let transcriptTruncated = false;
    let truncationNotice = '';

    if (transcriptTokens > inputBudget) {
      // 走 map-reduce：先按句子 + 800 token 目标切块，map 抽取事实，reduce 拼回
      const {
        chunks,
        truncated,
        consumedChars,
        totalChars,
      } = chunkTextWithMeta(transcript, { chunkTargetTokens: 800 });
      reportLogger.info(
        {
          transcriptTokens,
          inputBudget,
          chunkCount: chunks.length,
          contextWindow,
        },
        'transcript 超出输入预算，启动 map-reduce 报告生成'
      );

      if (truncated) {
        transcriptTruncated = true;
        const coveredPct =
          totalChars > 0 ? Math.round((consumedChars / totalChars) * 100) : 0;
        truncationNotice = buildTruncationNotice(coveredPct, language);
        // M17：此前触顶完全静默 —— 日志里只有 chunkCount，没有任何"被截断"的信号，
        // 用户只会拿到一份莫名少了尾段的报告。
        reportLogger.warn(
          {
            chunkCount: chunks.length,
            consumedChars,
            totalChars,
            coveredPct,
            transcriptTokens,
          },
          '转录切块触顶 maxChunks，尾段已被丢弃；报告只覆盖前半部分'
        );
      }

      const startedAt = Date.now();
      const chunkSummaries = await runMapStage(
        chunks.map((c) => ({ text: c.text, index: c.index })),
        chunks.length,
        language,
        callLLM
      );
      reportLogger.info(
        {
          chunkCount: chunks.length,
          mapDurationMs: Date.now() - startedAt,
        },
        'map 阶段完成'
      );

      finalTranscript = buildReducedTranscript(chunkSummaries);

      // 二次保险：reduce 输入若仍超 budget（极端长课程导致段摘要总量爆），
      // 按 token 从尾部截断，保留最近的段。
      const reducedTokens = estimateTokens(finalTranscript);
      if (reducedTokens > inputBudget) {
        finalTranscript = truncateToTokensFromEnd(finalTranscript, inputBudget);
        transcriptTruncated = true;
        if (!truncationNotice) {
          truncationNotice = buildTruncationNotice(null, language);
        }
        reportLogger.warn(
          {
            reducedTokens,
            inputBudget,
            chunkCount: chunks.length,
          },
          'reduce 输入仍超预算，按 token 截尾'
        );
      }

      if (truncationNotice) {
        // 也告诉模型它拿到的不是全文，避免它按"全场纪要"的口吻下结论。
        finalTranscript = `${truncationNotice}\n\n${finalTranscript}`;
      }
    }

    const { system, user } = buildSessionReportPrompt(
      finalTranscript,
      sessionTitle,
      courseName,
      durationMs,
      date,
      boundedSummaryContext,
      language
    );
    const result = await callLLM(system, user);
    const durationMinutes = Math.round(durationMs / 60000);
    const hours = Math.floor(durationMinutes / 60);
    const mins = durationMinutes % 60;
    const durationStr = formatReportDuration(hours, mins, language);

    const report = parseSessionReportResult(result, {
      sessionTitle,
      date,
      duration: durationStr,
    });

    // M17：截断必须在**产物里**可见，光有日志用户看不到。
    if (transcriptTruncated) {
      return {
        ...report,
        overview: report.overview
          ? `${truncationNotice}\n\n${report.overview}`
          : truncationNotice,
      };
    }
    return report;
  } catch (error) {
    reportLogger.error(
      { err: serializeError(error) },
      '报告生成失败'
    );
    return null;
  }
}

// ─── 标题生成 ───

/** 常规词数上限 */
const TITLE_LIMIT_ZH = 25;
const TITLE_LIMIT_EN = 15;
/** 严格词数上限 */
const TITLE_STRICT_ZH = 12;
const TITLE_STRICT_EN = 8;
/** 容忍超出的词数 */
const TITLE_TOLERANCE = 3;

interface GenerateTitleOptions {
  transcript: string;
  summaryBlocks: SummaryBlock[];
  courseName: string;
  language: string;
  callLLM: (system: string, user: string) => Promise<string>;
}

function isTitleWithinLimit(
  result: TitleGenerationResult,
  zhLimit: number,
  enLimit: number,
  tolerance: number
): boolean {
  const zhCount = countTitleWords(result.zh, 'zh');
  const enCount = countTitleWords(result.en, 'en');
  return zhCount <= zhLimit + tolerance && enCount <= enLimit + tolerance;
}

/**
 * 生成会话标题（中英文），含分阶段重试逻辑：
 * 1. 常规 prompt → 最多 2 次 → 容忍 +3 词
 * 2. 严格 prompt → 1 次 → 容忍 +3 词
 * 3. 兜底：接受最后一次结果
 */
export async function generateSessionTitle(
  options: GenerateTitleOptions
): Promise<TitleGenerationResult | null> {
  const { transcript, summaryBlocks, courseName, language, callLLM } = options;

  const summaryContext = summaryBlocks
    .map((block) => {
      const parts = [block.summary];
      if (block.keyPoints.length > 0) {
        parts.push('Key points: ' + block.keyPoints.join('; '));
      }
      return parts.join(' | ');
    })
    .join('\n')
    .slice(0, LLM_LIMITS.reportSummaryContext);

  let lastResult: TitleGenerationResult | null = null;

  // 阶段 1: 常规 prompt，最多 2 次
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { system, user } = buildTitleGenerationPrompt(
        transcript, summaryContext, courseName, language, false
      );
      const raw = await callLLM(system, user);
      lastResult = parseTitleGenerationResult(raw);

      if (isTitleWithinLimit(lastResult, TITLE_LIMIT_ZH, TITLE_LIMIT_EN, TITLE_TOLERANCE)) {
        return lastResult;
      }
      reportLogger.warn(
        {
          attempt: attempt + 1,
          zh: countTitleWords(lastResult.zh, 'zh'),
          en: countTitleWords(lastResult.en, 'en'),
        },
        '[title-gen] 常规尝试超出词数'
      );
    } catch (error) {
      reportLogger.error(
        { attempt: attempt + 1, err: serializeError(error) },
        '[title-gen] 常规尝试失败'
      );
    }
  }

  // 阶段 2: 严格 prompt，1 次
  try {
    const { system, user } = buildTitleGenerationPrompt(
      transcript, summaryContext, courseName, language, true
    );
    const raw = await callLLM(system, user);
    lastResult = parseTitleGenerationResult(raw);

    if (isTitleWithinLimit(lastResult, TITLE_STRICT_ZH, TITLE_STRICT_EN, TITLE_TOLERANCE)) {
      return lastResult;
    }
    reportLogger.warn(
      {
        zh: countTitleWords(lastResult.zh, 'zh'),
        en: countTitleWords(lastResult.en, 'en'),
      },
      '[title-gen] 严格尝试仍超词数'
    );
  } catch (error) {
    reportLogger.error(
      { err: serializeError(error) },
      '[title-gen] 严格尝试失败'
    );
  }

  // 阶段 3: 兜底 — 接受最后一次结果
  if (lastResult) {
    reportLogger.warn('[title-gen] 接受最后一次结果作为 fallback');
    return lastResult;
  }

  return null;
}
