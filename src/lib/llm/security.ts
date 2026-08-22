import type { SessionReport, SignificanceEvaluation } from '@/types/report';
import type { IncrementalSummaryResult } from '@/types/summary';

export class LLMValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMValidationError';
  }
}

export class LLMResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMResponseError';
  }
}

export const LLM_LIMITS = {
  question: 5000,
  transcriptContext: 50000,
  summaryContext: 50000,
  chatHistoryMessages: 100,
  chatMessage: 8000,
  chatHistoryTotal: 100000,
  newTranscript: 50000,
  runningContext: 50000,
  courseContext: 12000,
  language: 16,
  providerOverride: 100,
  requestedModel: 100,
  reportSummaryContext: 12000,
  /** 单条 chat 消息最多附带的图片张数 */
  chatImageCount: 4,
  /** 单张 chat 图片解码后的最大字节数（5MB） */
  chatImageBytes: 5 * 1024 * 1024,
  /** 客户端单次请求提交的 transcript 最大段数（远超真实多小时讲座，仅防滥用） */
  transcriptSegments: 100_000,
  /** 客户端单次请求提交的 transcript 最大总字符数（防超大数组触发 tokenizer CPU 放大） */
  transcriptTotalChars: 2_000_000,
} as const;

const PROMPT_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

type JsonObject = Record<string, unknown>;

function ensureString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new LLMValidationError(`${field} must be a string`);
  }
  return value.trim();
}

export function readRequiredText(
  value: unknown,
  field: string,
  maxLength: number
): string {
  const normalized = readOptionalText(value, field, maxLength);
  if (!normalized) {
    throw new LLMValidationError(`${field} is required`);
  }
  return normalized;
}

export function readOptionalText(
  value: unknown,
  field: string,
  maxLength: number
): string {
  if (value === undefined || value === null) {
    return '';
  }

  const normalized = ensureString(value, field);
  if (normalized.length > maxLength) {
    throw new LLMValidationError(`${field} too long`);
  }
  return normalized;
}

export function readOptionalIdentifier(
  value: unknown,
  field: string,
  maxLength: number
): string | undefined {
  const normalized = readOptionalText(value, field, maxLength);
  return normalized || undefined;
}

export function normalizeChatHistory(
  value: unknown
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new LLMValidationError('chatHistory must be an array');
  }

  if (value.length > LLM_LIMITS.chatHistoryMessages) {
    throw new LLMValidationError('Too many chat history messages');
  }

  let totalLength = 0;

  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new LLMValidationError(`chatHistory[${index}] must be an object`);
    }

    const role = (entry as Record<string, unknown>).role;
    if (role !== 'user' && role !== 'assistant') {
      throw new LLMValidationError(
        `chatHistory[${index}].role must be "user" or "assistant"`
      );
    }

    const content = readRequiredText(
      (entry as Record<string, unknown>).content,
      `chatHistory[${index}].content`,
      LLM_LIMITS.chatMessage
    );

    totalLength += content.length;
    if (totalLength > LLM_LIMITS.chatHistoryTotal) {
      throw new LLMValidationError('chatHistory total content too long');
    }

    return { role, content };
  });
}

export function wrapPromptBlock(
  tag: string,
  value: string,
  fallback = '[empty]'
): string {
  const content = value.trim() ? value : fallback;
  return `<${tag}>\n${sanitizePromptValue(content)}\n</${tag}>`;
}

export function sanitizePromptValue(value: string): string {
  return value
    .replace(PROMPT_CONTROL_CHARS, ' ')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 「围栏恰好包裹整个响应」的形状；只有命中它才剥围栏。 */
const WRAPPING_CODE_FENCE =
  /^```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/;
const LEADING_CODE_FENCE = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/;

/**
 * 剥掉 LLM 习惯性给 JSON 套的 markdown 代码围栏。
 *
 * L38②：此前是 `raw.replace(/```json|```/gi, '')` —— **全局**删掉所有围栏。
 * 报告/关键词这类响应的字符串值里完全可能合法地出现 ```（讲座讲到 markdown、
 * 转录里贴了代码块……），全局删除会改写正文；模型在围栏之外再补一句说明时，
 * 剩下的碎片还会 JSON.parse 失败 → 上层一律翻成 502「Invalid LLM response format」。
 * 改成只在「围栏恰好包裹整个响应」时剥一层，正文里的围栏原样保留。
 */
function stripJsonCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const wrapped = trimmed.match(WRAPPING_CODE_FENCE);
  if (wrapped) return wrapped[1].trim();
  // 只有开头围栏、没有收尾（响应被 max_tokens 截断）：剥掉开头那一行，尽力而为。
  if (trimmed.startsWith('```')) {
    return trimmed.replace(LEADING_CODE_FENCE, '').trim();
  }
  return trimmed;
}

function parseJsonObject(raw: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonCodeFences(raw));
  } catch {
    throw new LLMResponseError(`Invalid ${label}: response is not valid JSON`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LLMResponseError(`Invalid ${label}: expected a JSON object`);
  }

  return parsed as JsonObject;
}

function parseJsonArray(raw: string, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonCodeFences(raw));
  } catch {
    throw new LLMResponseError(`Invalid ${label}: response is not valid JSON`);
  }

  if (!Array.isArray(parsed)) {
    throw new LLMResponseError(`Invalid ${label}: expected a JSON array`);
  }

  return parsed;
}

function toBoundedString(
  value: unknown,
  maxLength: number,
  fallback = ''
): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.length > maxLength
    ? normalized.slice(0, maxLength)
    : normalized;
}

function toBoundedNumber(value: unknown, field: string): number {
  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(numericValue)) {
    throw new LLMResponseError(`Invalid ${field}: expected a finite number`);
  }

  return numericValue;
}

function toStringArray(
  value: unknown,
  maxItems: number,
  maxLength: number
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => (item.length > maxLength ? item.slice(0, maxLength) : item));
}

function toStringRecord(
  value: unknown,
  maxEntries: number,
  maxKeyLength: number,
  maxValueLength: number
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value)
    .filter(([, entryValue]) => typeof entryValue === 'string')
    .slice(0, maxEntries)
    .reduce<Record<string, string>>((acc, [entryKey, entryValue]) => {
      const key = entryKey.trim();
      const boundedValue = (entryValue as string).trim();
      if (!key || !boundedValue) {
        return acc;
      }

      acc[
        key.length > maxKeyLength ? key.slice(0, maxKeyLength) : key
      ] =
        boundedValue.length > maxValueLength
          ? boundedValue.slice(0, maxValueLength)
          : boundedValue;
      return acc;
    }, {});
}

export function parseIncrementalSummaryResult(
  raw: string
): IncrementalSummaryResult {
  const parsed = parseJsonObject(raw, 'incremental summary response');

  const newSummary = toBoundedString(parsed.new_summary, 4000);
  const updatedRunningContext = toBoundedString(
    parsed.updated_running_context,
    LLM_LIMITS.runningContext
  );

  if (!newSummary || !updatedRunningContext) {
    throw new LLMResponseError(
      'Invalid incremental summary response: missing required summary fields'
    );
  }

  return {
    new_key_points: toStringArray(parsed.new_key_points, 50, 500),
    new_definitions: toStringRecord(parsed.new_definitions, 50, 120, 1000),
    new_summary: newSummary,
    new_questions: toStringArray(parsed.new_questions, 20, 500),
    updated_running_context: updatedRunningContext,
  };
}

export function parseKeywordExtractionResult(raw: string): string[] {
  const parsed = parseJsonArray(raw, 'keyword extraction response');

  return parsed
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 100)
    .map((item) => (item.length > 120 ? item.slice(0, 120) : item));
}

export function parseSignificanceEvaluationResult(
  raw: string,
  threshold: number
): SignificanceEvaluation {
  const parsed = parseJsonObject(raw, 'significance evaluation response');
  const score = Math.max(0, Math.min(1, toBoundedNumber(parsed.score, 'score')));
  const explicitWorth = parsed.isWorthSummarizing;

  return {
    score,
    reason: toBoundedString(parsed.reason, 2000),
    isWorthSummarizing:
      typeof explicitWorth === 'boolean' ? explicitWorth : score >= threshold,
  };
}

/** 统计标题词数 — 中文按字符数（去除标点），英文按空格拆分单词数 */
export function countTitleWords(text: string, lang: 'zh' | 'en'): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  if (lang === 'zh') {
    // 去除标点和空格，只保留 CJK 字符和字母/数字
    const chars = trimmed.replace(/[\s\p{P}\p{S}]/gu, '');
    return chars.length;
  }
  // 英文：按空格拆分
  return trimmed.split(/\s+/).filter(Boolean).length;
}

export interface TitleGenerationResult {
  zh: string;
  en: string;
}

/**
 * 标题落库长度上限（L40）。
 *
 * `Session.title` 在 schema 里是 `String` → MySQL `VARCHAR(191)`；此前本函数对 zh/en
 * **不做任何截断**（其余所有字段都走 toBoundedString），模型一旦吐出超长标题，
 * `prisma.session.update` 直接抛错，整个标题任务失败（连带 fallback 也失败）。
 * 120 远小于 191（留足多字节与后缀余量），也远大于常规 25 字 / 15 词的期望长度 ——
 * 词数超限的重试逻辑不受影响：截断后的超长标题依然超词数，照常触发重试。
 */
const TITLE_MAX_CHARS = 120;

/** 解析标题生成 LLM 响应 — 保留内容标点，仅在超长时按落库上限截断 */
export function parseTitleGenerationResult(raw: string): TitleGenerationResult {
  const parsed = parseJsonObject(raw, 'title generation response');

  const zh = ensureString(parsed.zh, 'zh')
    .replace(PROMPT_CONTROL_CHARS, ' ')
    .replace(/\n/g, ' ')
    .trim()
    .slice(0, TITLE_MAX_CHARS)
    .trim();

  const en = ensureString(parsed.en, 'en')
    .replace(PROMPT_CONTROL_CHARS, ' ')
    .replace(/\n/g, ' ')
    .trim()
    .slice(0, TITLE_MAX_CHARS)
    .trim();

  if (!zh || !en) {
    throw new LLMResponseError(
      'Invalid title generation response: both zh and en titles are required'
    );
  }

  return { zh, en };
}

export function parseSessionReportResult(
  raw: string,
  fallback: { sessionTitle: string; date: string; duration: string }
): SessionReport {
  const parsed = parseJsonObject(raw, 'session report response');

  const sections = Array.isArray(parsed.sections)
    ? parsed.sections
        .filter(
          (section): section is JsonObject =>
            Boolean(section) &&
            typeof section === 'object' &&
            !Array.isArray(section)
        )
        .slice(0, 20)
        .map((section) => ({
          title: toBoundedString(section.title, 300),
          points: toStringArray(section.points, 10, 500),
        }))
        .filter((section) => section.title || section.points.length > 0)
    : [];

  const participants = toStringArray(parsed.participants, 20, 120);

  return {
    title:
      toBoundedString(parsed.title, 300, fallback.sessionTitle) ||
      fallback.sessionTitle,
    topic: toBoundedString(parsed.topic, 1000),
    participants: participants.length > 0 ? participants : ['Unknown'],
    date: toBoundedString(parsed.date, 64, fallback.date) || fallback.date,
    duration:
      toBoundedString(parsed.duration, 64, fallback.duration) || fallback.duration,
    overview: toBoundedString(parsed.overview, 4000),
    sections,
    conclusions: toStringArray(parsed.conclusions, 20, 500),
    actionItems: toStringArray(parsed.actionItems, 20, 500),
    keyTerms: toStringRecord(parsed.keyTerms, 50, 120, 1000),
  };
}
