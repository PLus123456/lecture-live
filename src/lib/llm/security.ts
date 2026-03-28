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

function stripJsonCodeFences(raw: string): string {
  return raw.replace(/```json|```/gi, '').trim();
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
