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
    callLLM
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
    console.error('意义评估失败，默认生成报告:', error);
    // 评估失败时默认认为值得生成报告（宁可多生成，不漏掉）
    return {
      score: 0.5,
      reason: '意义评估调用失败，默认生成报告',
      isWorthSummarizing: true,
    };
  }
}

/** 生成结构化会议报告 */
async function generateReport(
  transcript: string,
  sessionTitle: string,
  courseName: string,
  durationMs: number,
  date: string,
  summaryContext: string,
  language: string,
  callLLM: (system: string, user: string) => Promise<string>
): Promise<SessionReport | null> {
  try {
    const { system, user } = buildSessionReportPrompt(
      transcript,
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
    console.error('报告生成失败:', error);
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
      console.warn(
        `[title-gen] attempt ${attempt + 1} too long: zh=${countTitleWords(lastResult.zh, 'zh')} en=${countTitleWords(lastResult.en, 'en')}`
      );
    } catch (error) {
      console.error(`[title-gen] attempt ${attempt + 1} failed:`, error);
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
    console.warn(
      `[title-gen] strict attempt too long: zh=${countTitleWords(lastResult.zh, 'zh')} en=${countTitleWords(lastResult.en, 'en')}`
    );
  } catch (error) {
    console.error('[title-gen] strict attempt failed:', error);
  }

  // 阶段 3: 兜底 — 接受最后一次结果
  if (lastResult) {
    console.warn('[title-gen] accepting last result as fallback');
    return lastResult;
  }

  return null;
}
