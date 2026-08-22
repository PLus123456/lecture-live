import type { StorageCategory } from '@/lib/storage/cloudreve';
import type { PersistedTranscriptBundle } from '@/lib/sessionPersistence';
import type { TranscriptDraftPayload } from '@/lib/transcriptDraftPersistence';
import { LANGUAGES } from '@/lib/languages';

const SESSION_AUDIO_SOURCES = ['microphone', 'system_audio'] as const;
const SESSION_REGIONS = ['auto', 'us', 'eu', 'jp'] as const;
const SESSION_EXPORT_FORMATS = ['markdown', 'srt', 'json', 'txt'] as const;

export type SessionAudioSource = (typeof SESSION_AUDIO_SOURCES)[number];
export type SessionRegion = (typeof SESSION_REGIONS)[number];
export type SessionExportFormat = (typeof SESSION_EXPORT_FORMATS)[number];

/**
 * Session transcript request limits. These guard the JSON parse/persistence
 * boundary; LLM/RAG admission has its own, deliberately smaller token limits.
 */
export const SESSION_TRANSCRIPT_LIMITS = {
  maxRequestBytes: 8 * 1024 * 1024,
  maxPersistedJsonBytes: 8 * 1024 * 1024,
  maxSegments: 10_000,
  maxSummaries: 500,
  maxTranslations: 10_000,
  maxIdUtf8Bytes: 256,
  maxMetadataUtf8Bytes: 256,
  maxTextUtf8Bytes: 64 * 1024,
  maxSummaryListItems: 200,
  maxDefinitions: 200,
  maxTimelineMs: 2_147_483_647,
} as const;

export class SessionTranscriptPayloadError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 413
  ) {
    super(message);
    this.name = 'SessionTranscriptPayloadError';
  }
}

const BUNDLE_KEYS = new Set(['segments', 'summaries', 'translations']);
const SEGMENT_KEYS = new Set([
  'id',
  'sessionIndex',
  'speaker',
  'language',
  'text',
  'translatedText',
  'globalStartMs',
  'globalEndMs',
  'startMs',
  'endMs',
  'isFinal',
  'confidence',
  'timestamp',
]);
const SUMMARY_KEYS = new Set([
  'id',
  'blockIndex',
  'timeRange',
  'keyPoints',
  'definitions',
  'summary',
  'suggestedQuestions',
  'frozen',
]);
const LEGACY_SUMMARY_KEYS = new Set([
  'keyPoints',
  'definitions',
  'summary',
  'suggestedQuestions',
  'timeRange',
  'timestamp',
]);
const TIME_RANGE_KEYS = new Set(['startMs', 'endMs']);
const DRAFT_METADATA_KEYS = new Set([
  'clientTs',
  'recordingStartTime',
  'pausedAt',
  'totalPausedMs',
  'totalDurationMs',
  'summaryRunningContext',
  'currentSessionIndex',
]);
const FINALIZE_ENVELOPE_KEYS = new Set(['durationMs', 'title']);
const UNSAFE_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function invalidTranscript(message: string): never {
  throw new SessionTranscriptPayloadError(message, 400);
}

function oversizedTranscript(message: string): never {
  throw new SessionTranscriptPayloadError(message, 413);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) invalidTranscript(`${label} must be an object`);
  return value;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (!allowed.has(key)) invalidTranscript(`${label}.${key} is not allowed`);
  }
}

function requireArray(
  value: unknown,
  label: string,
  maxItems: number
): unknown[] {
  if (!Array.isArray(value)) invalidTranscript(`${label} must be an array`);
  if (value.length > maxItems) oversizedTranscript(`${label} has too many items`);
  return value;
}

function requireString(
  value: unknown,
  label: string,
  maxUtf8Bytes: number
): string {
  if (typeof value !== 'string') invalidTranscript(`${label} must be a string`);
  if (Buffer.byteLength(value, 'utf8') > maxUtf8Bytes) {
    oversizedTranscript(`${label} exceeds its UTF-8 byte limit`);
  }
  return value;
}

function requireRecordKey(value: unknown, label: string): string {
  const key = requireString(
    value,
    label,
    SESSION_TRANSCRIPT_LIMITS.maxIdUtf8Bytes
  );
  if (!key || UNSAFE_RECORD_KEYS.has(key)) {
    invalidTranscript(`${label} is invalid`);
  }
  return key;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidTranscript(`${label} must be a finite number`);
  }
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    invalidTranscript(`${label} must be a safe integer`);
  }
  return value;
}

function requireNumberInRange(
  value: unknown,
  label: string,
  min: number,
  max: number
): number {
  const number = requireFiniteNumber(value, label);
  if (number < min || number > max) {
    invalidTranscript(`${label} is outside the allowed range`);
  }
  return number;
}

function requireNonnegativeSafeInteger(value: unknown, label: string): number {
  const number = requireSafeInteger(value, label);
  if (number < 0) invalidTranscript(`${label} must be non-negative`);
  return number;
}

function requireIndex(value: unknown, label: string): number {
  const number = requireNonnegativeSafeInteger(value, label);
  if (number > SESSION_TRANSCRIPT_LIMITS.maxTimelineMs) {
    invalidTranscript(`${label} is outside the allowed range`);
  }
  return number;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalidTranscript(`${label} must be a boolean`);
  return value;
}

function canonicalizeTimeAlias(
  primary: unknown,
  alias: unknown,
  primaryLabel: string,
  aliasLabel: string
): number {
  if (primary === undefined && alias === undefined) {
    invalidTranscript(`${primaryLabel} or ${aliasLabel} is required`);
  }
  const primaryValue =
    primary === undefined
      ? undefined
      : requireNumberInRange(
          primary,
          primaryLabel,
          0,
          SESSION_TRANSCRIPT_LIMITS.maxTimelineMs
        );
  const aliasValue =
    alias === undefined
      ? undefined
      : requireNumberInRange(
          alias,
          aliasLabel,
          0,
          SESSION_TRANSCRIPT_LIMITS.maxTimelineMs
        );
  if (
    primaryValue !== undefined &&
    aliasValue !== undefined &&
    primaryValue !== aliasValue
  ) {
    invalidTranscript(`${primaryLabel} and ${aliasLabel} must match`);
  }
  return primaryValue ?? aliasValue!;
}

function canonicalizeSegment(value: unknown, index: number): Record<string, unknown> {
  const label = `segments[${index}]`;
  const input = requireRecord(value, label);
  assertAllowedKeys(input, SEGMENT_KEYS, label);
  const startMs = canonicalizeTimeAlias(
    input.globalStartMs,
    input.startMs,
    `${label}.globalStartMs`,
    `${label}.startMs`
  );
  const endMs = canonicalizeTimeAlias(
    input.globalEndMs,
    input.endMs,
    `${label}.globalEndMs`,
    `${label}.endMs`
  );
  if (startMs > endMs) invalidTranscript(`${label} starts after it ends`);
  const isLegacyAliasOnly =
    input.globalStartMs === undefined && input.globalEndMs === undefined;
  const segment: Record<string, unknown> = {
    id: requireRecordKey(input.id, `${label}.id`),
    sessionIndex:
      input.sessionIndex === undefined && isLegacyAliasOnly
        ? 0
        : requireIndex(input.sessionIndex, `${label}.sessionIndex`),
    speaker: requireString(
      input.speaker,
      `${label}.speaker`,
      SESSION_TRANSCRIPT_LIMITS.maxMetadataUtf8Bytes
    ),
    language: requireString(
      input.language,
      `${label}.language`,
      SESSION_TRANSCRIPT_LIMITS.maxMetadataUtf8Bytes
    ),
    text: requireString(
      input.text,
      `${label}.text`,
      SESSION_TRANSCRIPT_LIMITS.maxTextUtf8Bytes
    ),
    globalStartMs: startMs,
    globalEndMs: endMs,
    startMs,
    endMs,
    isFinal: requireBoolean(input.isFinal, `${label}.isFinal`),
    confidence: requireNumberInRange(
      input.confidence,
      `${label}.confidence`,
      0,
      1
    ),
    timestamp: requireString(
      input.timestamp,
      `${label}.timestamp`,
      SESSION_TRANSCRIPT_LIMITS.maxMetadataUtf8Bytes
    ),
  };
  if (input.translatedText !== undefined) {
    segment.translatedText = requireString(
      input.translatedText,
      `${label}.translatedText`,
      SESSION_TRANSCRIPT_LIMITS.maxTextUtf8Bytes
    );
  }
  return segment;
}

function canonicalizeStringList(value: unknown, label: string): string[] {
  return requireArray(
    value,
    label,
    SESSION_TRANSCRIPT_LIMITS.maxSummaryListItems
  ).map((entry, index) =>
    requireString(
      entry,
      `${label}[${index}]`,
      SESSION_TRANSCRIPT_LIMITS.maxTextUtf8Bytes
    )
  );
}

function canonicalizeDefinitions(value: unknown, label: string): Record<string, string> {
  const input = requireRecord(value, label);
  const definitions: Record<string, string> = {};
  let count = 0;
  for (const rawKey in input) {
    if (!Object.hasOwn(input, rawKey)) continue;
    count += 1;
    if (count > SESSION_TRANSCRIPT_LIMITS.maxDefinitions) {
      oversizedTranscript(`${label} has too many entries`);
    }
    const key = requireRecordKey(rawKey, `${label} key`);
    definitions[key] = requireString(
      input[rawKey],
      `${label}.${key}`,
      SESSION_TRANSCRIPT_LIMITS.maxTextUtf8Bytes
    );
  }
  return definitions;
}

function canonicalizeSummary(value: unknown, index: number): Record<string, unknown> {
  const label = `summaries[${index}]`;
  const input = requireRecord(value, label);
  const isLegacy =
    !('id' in input) &&
    !('blockIndex' in input) &&
    (input.timeRange === undefined || typeof input.timeRange === 'string');
  if (isLegacy) {
    assertAllowedKeys(input, LEGACY_SUMMARY_KEYS, label);
    const legacy: Record<string, unknown> = {
      keyPoints: canonicalizeStringList(input.keyPoints, `${label}.keyPoints`),
      timestamp: requireNonnegativeSafeInteger(
        input.timestamp,
        `${label}.timestamp`
      ),
    };
    if (input.definitions !== undefined) {
      legacy.definitions = canonicalizeDefinitions(
        input.definitions,
        `${label}.definitions`
      );
    }
    if (input.summary !== undefined) {
      legacy.summary = requireString(
        input.summary,
        `${label}.summary`,
        SESSION_TRANSCRIPT_LIMITS.maxTextUtf8Bytes
      );
    }
    if (input.suggestedQuestions !== undefined) {
      legacy.suggestedQuestions = canonicalizeStringList(
        input.suggestedQuestions,
        `${label}.suggestedQuestions`
      );
    }
    if (input.timeRange !== undefined) {
      legacy.timeRange = requireString(
        input.timeRange,
        `${label}.timeRange`,
        SESSION_TRANSCRIPT_LIMITS.maxMetadataUtf8Bytes
      );
    }
    return legacy;
  }

  assertAllowedKeys(input, SUMMARY_KEYS, label);
  const timeRange = requireRecord(input.timeRange, `${label}.timeRange`);
  assertAllowedKeys(timeRange, TIME_RANGE_KEYS, `${label}.timeRange`);
  const startMs = requireNumberInRange(
    timeRange.startMs,
    `${label}.timeRange.startMs`,
    0,
    SESSION_TRANSCRIPT_LIMITS.maxTimelineMs
  );
  const endMs = requireNumberInRange(
    timeRange.endMs,
    `${label}.timeRange.endMs`,
    0,
    SESSION_TRANSCRIPT_LIMITS.maxTimelineMs
  );
  if (startMs > endMs) invalidTranscript(`${label}.timeRange is reversed`);
  return {
    id: requireRecordKey(input.id, `${label}.id`),
    blockIndex: requireIndex(input.blockIndex, `${label}.blockIndex`),
    timeRange: {
      startMs,
      endMs,
    },
    keyPoints: canonicalizeStringList(input.keyPoints, `${label}.keyPoints`),
    definitions: canonicalizeDefinitions(
      input.definitions,
      `${label}.definitions`
    ),
    summary: requireString(
      input.summary,
      `${label}.summary`,
      SESSION_TRANSCRIPT_LIMITS.maxTextUtf8Bytes
    ),
    suggestedQuestions: canonicalizeStringList(
      input.suggestedQuestions,
      `${label}.suggestedQuestions`
    ),
    frozen: requireBoolean(input.frozen, `${label}.frozen`),
  };
}

function canonicalizeTranslations(value: unknown): Record<string, string> {
  const input = requireRecord(value, 'translations');
  const translations: Record<string, string> = {};
  let count = 0;
  for (const rawKey in input) {
    if (!Object.hasOwn(input, rawKey)) continue;
    count += 1;
    if (count > SESSION_TRANSCRIPT_LIMITS.maxTranslations) {
      oversizedTranscript('translations has too many entries');
    }
    const key = requireRecordKey(rawKey, 'translations key');
    translations[key] = requireString(
      input[rawKey],
      `translations.${key}`,
      SESSION_TRANSCRIPT_LIMITS.maxTextUtf8Bytes
    );
  }
  return translations;
}

function assertPersistedJsonBytes(value: unknown, label: string): void {
  const serialized = JSON.stringify(value, null, 2);
  if (
    Buffer.byteLength(serialized, 'utf8') >
    SESSION_TRANSCRIPT_LIMITS.maxPersistedJsonBytes
  ) {
    oversizedTranscript(
      `${label} exceeds ${SESSION_TRANSCRIPT_LIMITS.maxPersistedJsonBytes} serialized UTF-8 bytes`
    );
  }
}

/**
 * Strictly validates and canonicalizes the only object graph that may be
 * persisted as a session transcript. Unknown fields are rejected, so deeply
 * nested attacker data cannot be copied through an otherwise valid segment.
 */
export function admitPersistedTranscriptBundle(
  payload: unknown,
  options: { allowedEnvelopeKeys?: ReadonlySet<string> } = {}
): PersistedTranscriptBundle {
  const input = requireRecord(payload, 'transcript payload');
  const allowed = new Set(BUNDLE_KEYS);
  for (const key of options.allowedEnvelopeKeys ?? []) allowed.add(key);
  assertAllowedKeys(input, allowed, 'transcript payload');

  const segments = requireArray(
    input.segments,
    'segments',
    SESSION_TRANSCRIPT_LIMITS.maxSegments
  ).map(canonicalizeSegment);
  const summaries = requireArray(
    input.summaries,
    'summaries',
    SESSION_TRANSCRIPT_LIMITS.maxSummaries
  ).map(canonicalizeSummary);
  const bundle: PersistedTranscriptBundle = {
    segments,
    summaries,
    translations: canonicalizeTranslations(input.translations),
  };
  assertPersistedJsonBytes(bundle, 'transcript payload');
  return bundle;
}

/** Validate the draft envelope and the persisted transcript graph together. */
export function admitTranscriptDraftPayload(
  payload: unknown,
  nowMs = Date.now()
): TranscriptDraftPayload {
  const input = requireRecord(payload, 'transcript draft');
  const bundle = admitPersistedTranscriptBundle(input, {
    allowedEnvelopeKeys: DRAFT_METADATA_KEYS,
  });
  const draft: TranscriptDraftPayload = {
    ...bundle,
    clientTs:
      input.clientTs === undefined
        ? requireNonnegativeSafeInteger(nowMs, 'server timestamp')
        : requireNonnegativeSafeInteger(input.clientTs, 'clientTs'),
  };

  for (const key of ['recordingStartTime', 'pausedAt'] as const) {
    const value = input[key];
    if (value !== undefined && value !== null) {
      draft[key] = requireNonnegativeSafeInteger(value, key);
    }
  }
  for (const key of ['totalPausedMs', 'totalDurationMs'] as const) {
    const value = input[key];
    if (value !== undefined && value !== null) {
      draft[key] = requireNumberInRange(
        value,
        key,
        0,
        SESSION_TRANSCRIPT_LIMITS.maxTimelineMs
      );
    }
  }
  if (input.currentSessionIndex !== undefined && input.currentSessionIndex !== null) {
    draft.currentSessionIndex = requireIndex(
      input.currentSessionIndex,
      'currentSessionIndex'
    );
  }
  if (input.summaryRunningContext !== undefined) {
    draft.summaryRunningContext = requireString(
      input.summaryRunningContext,
      'summaryRunningContext',
      SESSION_TRANSCRIPT_LIMITS.maxTextUtf8Bytes
    );
  }
  assertPersistedJsonBytes(draft, 'transcript draft');
  return draft;
}

export interface AdmittedSessionFinalizePayload {
  clientBundle: PersistedTranscriptBundle | null;
  clientDurationMs?: number;
  clientTitle?: string;
}

/** Validate the finalize envelope without requiring a client transcript. */
export function admitSessionFinalizePayload(
  payload: unknown
): AdmittedSessionFinalizePayload {
  const input = requireRecord(payload, 'session finalize payload');
  const allowed = new Set([...BUNDLE_KEYS, ...FINALIZE_ENVELOPE_KEYS]);
  assertAllowedKeys(input, allowed, 'session finalize payload');

  const hasBundleField = [...BUNDLE_KEYS].some((key) => key in input);
  const result: AdmittedSessionFinalizePayload = {
    clientBundle: hasBundleField
      ? admitPersistedTranscriptBundle(input, {
          allowedEnvelopeKeys: FINALIZE_ENVELOPE_KEYS,
        })
      : null,
  };

  if (input.durationMs !== undefined && input.durationMs !== null) {
    const durationMs = requireNumberInRange(
      input.durationMs,
      'durationMs',
      0,
      SESSION_TRANSCRIPT_LIMITS.maxTimelineMs
    );
    if (durationMs > 0) result.clientDurationMs = durationMs;
  }
  if (input.title !== undefined && input.title !== null) {
    const title = requireString(
      input.title,
      'title',
      SESSION_TRANSCRIPT_LIMITS.maxTextUtf8Bytes
    )
      .trim()
      .slice(0, 160);
    if (title) result.clientTitle = title;
  }
  return result;
}

/**
 * Read a JSON object while counting actual stream bytes. Content-Length is
 * only an early rejection; missing/dishonest headers cannot bypass the cap.
 */
export async function readBoundedSessionJson(
  req: Request,
  options: { allowEmpty?: boolean; maxBytes?: number } = {}
): Promise<Record<string, unknown> | null> {
  const maxBytes = options.maxBytes ?? SESSION_TRANSCRIPT_LIMITS.maxRequestBytes;
  const declared = req.headers.get('content-length')?.trim();
  if (declared && /^\d+$/.test(declared)) {
    try {
      if (BigInt(declared) > BigInt(maxBytes)) {
        oversizedTranscript(`request body exceeds ${maxBytes} bytes`);
      }
    } catch (error) {
      if (error instanceof SessionTranscriptPayloadError) throw error;
      oversizedTranscript(`request body exceeds ${maxBytes} bytes`);
    }
  }

  if (!req.body) {
    if (options.allowEmpty) return null;
    invalidTranscript('request body must be a JSON object');
  }

  const reader = req.body.getReader();
  let bytes = new Uint8Array(Math.min(maxBytes, 4 * 1024));
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const nextReceived = received + value.byteLength;
      if (nextReceived > maxBytes) {
        await reader.cancel('session transcript body exceeds byte limit').catch(() => undefined);
        oversizedTranscript(`request body exceeds ${maxBytes} bytes`);
      }
      if (nextReceived > bytes.byteLength) {
        const nextCapacity = Math.min(
          maxBytes,
          Math.max(nextReceived, Math.max(1, bytes.byteLength * 2))
        );
        const grown = new Uint8Array(nextCapacity);
        grown.set(bytes.subarray(0, received));
        bytes = grown;
      }
      bytes.set(value, received);
      received = nextReceived;
    }
  } catch (error) {
    if (error instanceof SessionTranscriptPayloadError) throw error;
    invalidTranscript('request body could not be read');
  } finally {
    reader.releaseLock();
  }

  if (received === 0) {
    if (options.allowEmpty) return null;
    invalidTranscript('request body must be a JSON object');
  }

  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, received)
      )
    );
    return requireRecord(parsed, 'request body');
  } catch (error) {
    if (error instanceof SessionTranscriptPayloadError) throw error;
    invalidTranscript('request body must contain valid UTF-8 JSON');
  }
}

export function normalizeSessionAudioSource(
  value: unknown
): SessionAudioSource | null {
  if (typeof value !== 'string') {
    return null;
  }

  if (value === 'mic') return 'microphone';
  if (value === 'system') return 'system_audio';

  return SESSION_AUDIO_SOURCES.includes(value as SessionAudioSource)
    ? (value as SessionAudioSource)
    : null;
}

export function normalizeSessionRegion(value: unknown): SessionRegion | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.toLowerCase();
  return SESSION_REGIONS.includes(normalized as SessionRegion)
    ? (normalized as SessionRegion)
    : null;
}

export function normalizeOptionalString(
  value: unknown,
  maxLength: number
): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, maxLength);
}

const VALID_LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code));

export function normalizeLanguageCode(
  value: unknown,
  fallback: string
): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase().slice(0, 16);
  if (!normalized || !VALID_LANGUAGE_CODES.has(normalized)) {
    return fallback;
  }

  return normalized;
}

const VALID_TRANSLATION_MODES = ['soniox', 'local', 'both'] as const;

export function normalizeTranslationMode(value: unknown): string {
  if (
    typeof value === 'string' &&
    VALID_TRANSLATION_MODES.includes(value as 'soniox' | 'local' | 'both')
  ) {
    return value;
  }
  return 'soniox';
}

export function isStorageCategoryValue(value: unknown): value is StorageCategory {
  return (
    typeof value === 'string' &&
    (value === 'recordings' || value === 'transcripts' || value === 'summaries')
  );
}

export function validatePersistedTranscriptBundle(
  payload: unknown
): PersistedTranscriptBundle | null {
  try {
    return admitPersistedTranscriptBundle(payload);
  } catch {
    return null;
  }
}

export function normalizeExportFormat(
  value: unknown
): SessionExportFormat | null {
  if (typeof value !== 'string') {
    return null;
  }

  return SESSION_EXPORT_FORMATS.includes(value as SessionExportFormat)
    ? (value as SessionExportFormat)
    : null;
}
