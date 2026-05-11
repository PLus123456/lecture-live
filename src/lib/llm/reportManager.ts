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
import { estimateTokens } from './tokenizer';
import { chunkText } from './chunking';
import { logger, serializeError } from '@/lib/logger';

const reportLogger = logger.child({ component: 'report-manager' });

/** Map-reduce 默认并发数（用户敲定 3） */
const MAP_REDUCE_CONCURRENCY = 3;

/**
 * 默认 contextWindow —— 调用方未传时用的保守值。生产环境应该总是从 provider
 * 配置里读出 contextWindow 传进来。
 */
const DEFAULT_CONTEXT_WINDOW = 16384;

/**
 * 计算 final summary 阶段的"transcript 输入预算"。
 *
 * 思路：contextWindow × 0.8（安全冗余）减去 system prompt（~1500）、
 * summary context（最多 12000 字符 ≈ 9000 token）、输出预留（~4000）。
 * 剩下的 token 是 transcript 能塞进去的最大量。
 *
 * 当 contextWindow=200K 时预算 ~143K（基本随便塞）；
 * 当 contextWindow=16K 时预算 ~700（必走 map-reduce）。
 */
function computeTranscriptInputBudget(contextWindow: number): number {
  const usable = Math.floor(contextWindow * 0.8) - 1500 - 9000 - 4000;
  return Math.max(2000, usable);
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
    contextWindow = DEFAULT_CONTEXT_WINDOW,
  } = options;

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
    const inputBudget = computeTranscriptInputBudget(contextWindow);
    const transcriptTokens = estimateTokens(transcript);

    let finalTranscript = transcript;

    if (transcriptTokens > inputBudget) {
      // 走 map-reduce：先按句子 + 800 token 目标切块，map 抽取事实，reduce 拼回
      const chunks = chunkText(transcript, { chunkTargetTokens: 800 });
      reportLogger.info(
        {
          transcriptTokens,
          inputBudget,
          chunkCount: chunks.length,
          contextWindow,
        },
        'transcript 超出输入预算，启动 map-reduce 报告生成'
      );

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
        const { truncateToTokensFromEnd } = await import('./tokenizer');
        finalTranscript = truncateToTokensFromEnd(finalTranscript, inputBudget);
        reportLogger.warn(
          {
            reducedTokens,
            inputBudget,
            chunkCount: chunks.length,
          },
          'reduce 输入仍超预算，按 token 截尾'
        );
      }
    }

    const { system, user } = buildSessionReportPrompt(
      finalTranscript,
      sessionTitle,
      courseName,
      durationMs,
      date,
      summaryContext,
      language
    );
    const result = await callLLM(system, user);
    const durationMinutes = Math.round(durationMs / 60000);
    const hours = Math.floor(durationMinutes / 60);
    const mins = durationMinutes % 60;
    const durationStr = formatReportDuration(hours, mins, language);

    return parseSessionReportResult(result, {
      sessionTitle,
      date,
      duration: durationStr,
    });
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
