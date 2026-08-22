// 直播快照的唯一规范化与内存预算边界。
//
// 所有来自 Socket.IO 或磁盘恢复的快照都必须先变成这里定义的 canonical 结构，
// 未知字段不会进入常驻内存；所有限额均按 JSON 的 UTF-8 实际字节计算，而不是 JS
// 字符数。LiveSnapshotStore 的预算检查与账本更新是同步完成的，中间没有 await，因而
// 同一 WS 进程内不会出现两个并发事件共同越过 session/user/global 上限的窗口。

export const MAX_LIVE_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_LIVE_SNAPSHOT_BYTES_PER_USER = 16 * 1024 * 1024;
export const MAX_LIVE_SNAPSHOT_BYTES_GLOBAL = 128 * 1024 * 1024;
export const MAX_LIVE_PERSISTED_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_LIVE_INITIAL_STATE_BYTES_PER_SOCKET = 8 * 1024 * 1024;

export const MAX_LIVE_SNAPSHOT_SEGMENTS = 10_000;
export const MAX_LIVE_SNAPSHOT_SUMMARY_BLOCKS = 10_000;
export const MAX_LIVE_SNAPSHOT_TRANSLATIONS = 10_000;
export const MAX_ACTIVE_LIVE_SNAPSHOTS_PER_USER = 64;
export const MAX_ACTIVE_LIVE_SNAPSHOTS_GLOBAL = 4_096;

const MAX_ID_BYTES = 256;
const MAX_METADATA_BYTES = 256;
const MAX_TEXT_BYTES = 40_000;
const MAX_SUMMARY_LIST_ITEMS = 200;
const MAX_SUMMARY_DEFINITIONS = 200;

const CLIENT_STATUS_VALUES = new Set([
  'CREATED',
  'RECORDING',
  'PAUSED',
  'FINALIZING',
  'COMPLETED',
  'ARCHIVED',
  'SHARE_OFFLINE',
]);
const PREVIEW_TRANSLATION_STATES = new Set([
  'idle',
  'waiting',
  'streaming',
  'final',
]);
const TRANSLATION_MODES = new Set(['soniox', 'local', 'both']);
const UNSAFE_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface CanonicalTranscriptSegment {
  id: string;
  sessionIndex: number;
  speaker: string;
  language: string;
  text: string;
  translatedText?: string;
  globalStartMs: number;
  globalEndMs: number;
  startMs: number;
  endMs: number;
  isFinal: boolean;
  confidence: number;
  timestamp: string;
}

export interface CanonicalSummaryBlock {
  id: string;
  blockIndex: number;
  timeRange: {
    startMs: number;
    endMs: number;
  };
  keyPoints: string[];
  definitions: Record<string, string>;
  summary: string;
  suggestedQuestions: string[];
  frozen: boolean;
}

export interface CanonicalPreviewText {
  finalText: string;
  nonFinalText: string;
}

export interface CanonicalPreviewTranslation extends CanonicalPreviewText {
  state: 'idle' | 'waiting' | 'streaming' | 'final';
  sourceLanguage: string | null;
}

export interface CanonicalLiveSnapshot {
  segments: CanonicalTranscriptSegment[];
  translations: Record<string, string>;
  summaryBlocks: CanonicalSummaryBlock[];
  status: string | null;
  previewText: CanonicalPreviewText;
  previewTranslation: CanonicalPreviewTranslation;
  sourceLang: string | null;
  targetLang: string | null;
  translationMode: 'soniox' | 'local' | 'both' | null;
  updatedAt: number;
}

export type CanonicalLiveEvent =
  | {
      type: 'transcript_delta';
      payload: CanonicalTranscriptSegment;
      timestamp: number;
    }
  | {
      type: 'translation_delta';
      payload: {
        segmentId: string;
        translation: string;
        sourceLang?: string;
        targetLang?: string;
        translationMode?: 'soniox' | 'local' | 'both';
      };
      timestamp: number;
    }
  | {
      type: 'summary_update';
      payload: CanonicalSummaryBlock;
      timestamp: number;
    }
  | {
      type: 'status_update';
      payload: { status: string };
      timestamp: number;
    }
  | {
      type: 'preview_update';
      payload: {
        previewText: CanonicalPreviewText;
        previewTranslation: CanonicalPreviewTranslation;
      };
      timestamp: number;
    };

export type LiveSnapshotPolicyErrorCode =
  | 'INVALID_SNAPSHOT'
  | 'INVALID_EVENT'
  | 'SNAPSHOT_NOT_FOUND'
  | 'SNAPSHOT_OWNER_MISMATCH'
  | 'SNAPSHOT_SESSION_LIMIT'
  | 'SNAPSHOT_USER_LIMIT'
  | 'SNAPSHOT_GLOBAL_LIMIT'
  | 'SNAPSHOT_COUNT_LIMIT';

export type LiveSnapshotPolicyResult<T> =
  | { ok: true; value: T; bytes: number }
  | {
      ok: false;
      code: LiveSnapshotPolicyErrorCode;
      message: string;
      bytes?: number;
      limit?: number;
    };

interface SnapshotRecord {
  ownerId: string;
  snapshot: CanonicalLiveSnapshot;
  bytes: number;
  segmentIndexes: Map<string, number>;
  segmentBytes: number[];
  translationMemberBytes: Map<string, number>;
  summaryIndexes: Map<string, number>;
  summaryBytes: number[];
}

interface SnapshotStoreLimits {
  perSessionBytes: number;
  perUserBytes: number;
  globalBytes: number;
  maxSegments: number;
  maxSummaryBlocks: number;
  maxTranslations: number;
  maxActiveSessionsPerUser: number;
  maxActiveSessionsGlobal: number;
}

interface SnapshotSetValue {
  snapshot: CanonicalLiveSnapshot;
  inserted: boolean;
}

interface AppliedEventValue {
  snapshot: CanonicalLiveSnapshot;
  event: CanonicalLiveEvent;
}

class PolicyViolation extends Error {}

export function utf8JsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new PolicyViolation('Value cannot be serialized as JSON');
  }
  return Buffer.byteLength(serialized, 'utf8');
}

/** Socket.IO event 的 JSON envelope（含 `42` 事件前缀）的精确 UTF-8 字节数。 */
export function socketIoEventByteLength(
  eventName: string,
  canonicalPayloadBytes: number
): number {
  // Socket.IO 文本事件格式：42["event",{...payload...}]
  return 2 + 3 + utf8JsonByteLength(eventName) + canonicalPayloadBytes;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new PolicyViolation(`${label} must be an object`);
  }
  return value;
}

function requireArray(value: unknown, label: string, maxItems: number): unknown[] {
  if (!Array.isArray(value)) {
    throw new PolicyViolation(`${label} must be an array`);
  }
  if (value.length > maxItems) {
    throw new PolicyViolation(`${label} has too many items`);
  }
  return value;
}

function requireString(
  value: unknown,
  label: string,
  maxBytes: number,
  options: { allowEmpty?: boolean } = {}
): string {
  if (typeof value !== 'string') {
    throw new PolicyViolation(`${label} must be a string`);
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new PolicyViolation(`${label} must not be empty`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new PolicyViolation(`${label} is too large`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PolicyViolation(`${label} must be a finite number`);
  }
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new PolicyViolation(`${label} must be a safe integer`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new PolicyViolation(`${label} must be a boolean`);
  }
  return value;
}

function requireRecordKey(value: unknown, label: string): string {
  const key = requireString(value, label, MAX_ID_BYTES);
  if (UNSAFE_RECORD_KEYS.has(key)) {
    throw new PolicyViolation(`${label} is reserved`);
  }
  return key;
}

function canonicalizeSegment(value: unknown): CanonicalTranscriptSegment {
  const input = requireRecord(value, 'segment');
  const segment: CanonicalTranscriptSegment = {
    id: requireRecordKey(input.id, 'segment.id'),
    sessionIndex: requireSafeInteger(input.sessionIndex, 'segment.sessionIndex'),
    speaker: requireString(input.speaker, 'segment.speaker', MAX_METADATA_BYTES, {
      allowEmpty: true,
    }),
    language: requireString(input.language, 'segment.language', MAX_METADATA_BYTES),
    text: requireString(input.text, 'segment.text', MAX_TEXT_BYTES, {
      allowEmpty: true,
    }),
    globalStartMs: requireFiniteNumber(input.globalStartMs, 'segment.globalStartMs'),
    globalEndMs: requireFiniteNumber(input.globalEndMs, 'segment.globalEndMs'),
    startMs: requireFiniteNumber(input.startMs, 'segment.startMs'),
    endMs: requireFiniteNumber(input.endMs, 'segment.endMs'),
    isFinal: requireBoolean(input.isFinal, 'segment.isFinal'),
    confidence: requireFiniteNumber(input.confidence, 'segment.confidence'),
    timestamp: requireString(input.timestamp, 'segment.timestamp', MAX_METADATA_BYTES, {
      allowEmpty: true,
    }),
  };

  if (input.translatedText !== undefined) {
    segment.translatedText = requireString(
      input.translatedText,
      'segment.translatedText',
      MAX_TEXT_BYTES,
      { allowEmpty: true }
    );
  }
  return segment;
}

function canonicalizeStringList(value: unknown, label: string): string[] {
  return requireArray(value, label, MAX_SUMMARY_LIST_ITEMS).map((item, index) =>
    requireString(item, `${label}[${index}]`, MAX_TEXT_BYTES, { allowEmpty: true })
  );
}

function canonicalizeDefinitions(value: unknown): Record<string, string> {
  const input = requireRecord(value, 'summary.definitions');
  const entries = Object.entries(input);
  if (entries.length > MAX_SUMMARY_DEFINITIONS) {
    throw new PolicyViolation('summary.definitions has too many entries');
  }

  const definitions: Record<string, string> = Object.create(null);
  for (const [rawKey, rawValue] of entries) {
    const key = requireRecordKey(rawKey, 'summary.definitions key');
    definitions[key] = requireString(
      rawValue,
      `summary.definitions.${key}`,
      MAX_TEXT_BYTES,
      { allowEmpty: true }
    );
  }
  return definitions;
}

function canonicalizeSummaryBlock(value: unknown): CanonicalSummaryBlock {
  const input = requireRecord(value, 'summary');
  const timeRange = requireRecord(input.timeRange, 'summary.timeRange');
  return {
    id: requireRecordKey(input.id, 'summary.id'),
    blockIndex: requireSafeInteger(input.blockIndex, 'summary.blockIndex'),
    timeRange: {
      startMs: requireFiniteNumber(timeRange.startMs, 'summary.timeRange.startMs'),
      endMs: requireFiniteNumber(timeRange.endMs, 'summary.timeRange.endMs'),
    },
    keyPoints: canonicalizeStringList(input.keyPoints, 'summary.keyPoints'),
    definitions: canonicalizeDefinitions(input.definitions),
    summary: requireString(input.summary, 'summary.summary', MAX_TEXT_BYTES, {
      allowEmpty: true,
    }),
    suggestedQuestions: canonicalizeStringList(
      input.suggestedQuestions,
      'summary.suggestedQuestions'
    ),
    frozen: requireBoolean(input.frozen, 'summary.frozen'),
  };
}

function canonicalizePreviewText(value: unknown): CanonicalPreviewText {
  const input = requireRecord(value, 'previewText');
  return {
    finalText: requireString(input.finalText, 'previewText.finalText', MAX_TEXT_BYTES, {
      allowEmpty: true,
    }),
    nonFinalText: requireString(
      input.nonFinalText,
      'previewText.nonFinalText',
      MAX_TEXT_BYTES,
      { allowEmpty: true }
    ),
  };
}

function canonicalizePreviewTranslation(
  value: unknown
): CanonicalPreviewTranslation {
  const input = requireRecord(value, 'previewTranslation');
  const state = requireString(
    input.state,
    'previewTranslation.state',
    MAX_METADATA_BYTES
  );
  if (!PREVIEW_TRANSLATION_STATES.has(state)) {
    throw new PolicyViolation('previewTranslation.state is invalid');
  }

  let sourceLanguage: string | null = null;
  if (input.sourceLanguage !== null) {
    sourceLanguage = requireString(
      input.sourceLanguage,
      'previewTranslation.sourceLanguage',
      MAX_METADATA_BYTES
    );
  }

  return {
    finalText: requireString(
      input.finalText,
      'previewTranslation.finalText',
      MAX_TEXT_BYTES,
      { allowEmpty: true }
    ),
    nonFinalText: requireString(
      input.nonFinalText,
      'previewTranslation.nonFinalText',
      MAX_TEXT_BYTES,
      { allowEmpty: true }
    ),
    state: state as CanonicalPreviewTranslation['state'],
    sourceLanguage,
  };
}

function canonicalizeNullableMetadata(
  value: unknown,
  label: string
): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, label, MAX_METADATA_BYTES);
}

function canonicalizeTranslationMode(
  value: unknown,
  options: { optional?: boolean } = {}
): CanonicalLiveSnapshot['translationMode'] | undefined {
  if (value === undefined && options.optional) return undefined;
  if (value === null || value === undefined) return null;
  const mode = requireString(value, 'translationMode', MAX_METADATA_BYTES);
  if (!TRANSLATION_MODES.has(mode)) {
    throw new PolicyViolation('translationMode is invalid');
  }
  return mode as CanonicalLiveSnapshot['translationMode'];
}

function canonicalizeStatus(value: unknown, allowNull: boolean): string | null {
  if (allowNull && (value === null || value === undefined)) return null;
  const status = requireString(value, 'status', MAX_METADATA_BYTES);
  if (!CLIENT_STATUS_VALUES.has(status)) {
    throw new PolicyViolation('status is invalid');
  }
  return status;
}

function canonicalizeTranslations(value: unknown): Record<string, string> {
  const input = requireRecord(value, 'translations');
  const entries = Object.entries(input);
  if (entries.length > MAX_LIVE_SNAPSHOT_TRANSLATIONS) {
    throw new PolicyViolation('translations has too many entries');
  }
  const translations: Record<string, string> = Object.create(null);
  for (const [rawKey, rawValue] of entries) {
    const key = requireRecordKey(rawKey, 'translation segmentId');
    translations[key] = requireString(
      rawValue,
      `translations.${key}`,
      MAX_TEXT_BYTES,
      { allowEmpty: true }
    );
  }
  return translations;
}

function assertUniqueIds(items: Array<{ id: string }>, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new PolicyViolation(`${label} contains duplicate id`);
    }
    seen.add(item.id);
  }
}

export function createEmptyLiveSnapshot(nowMs = Date.now()): CanonicalLiveSnapshot {
  return {
    segments: [],
    translations: Object.create(null),
    summaryBlocks: [],
    status: null,
    previewText: { finalText: '', nonFinalText: '' },
    previewTranslation: {
      finalText: '',
      nonFinalText: '',
      state: 'idle',
      sourceLanguage: null,
    },
    sourceLang: null,
    targetLang: null,
    translationMode: null,
    updatedAt: nowMs,
  };
}

export function canonicalizeLiveSnapshot(
  value: unknown,
  nowMs = Date.now()
): LiveSnapshotPolicyResult<CanonicalLiveSnapshot> {
  try {
    const input = requireRecord(value, 'snapshot');
    const segments = requireArray(
      input.segments,
      'snapshot.segments',
      MAX_LIVE_SNAPSHOT_SEGMENTS
    ).map(canonicalizeSegment);
    const summaryBlocks = requireArray(
      input.summaryBlocks,
      'snapshot.summaryBlocks',
      MAX_LIVE_SNAPSHOT_SUMMARY_BLOCKS
    ).map(canonicalizeSummaryBlock);
    assertUniqueIds(segments, 'snapshot.segments');
    assertUniqueIds(summaryBlocks, 'snapshot.summaryBlocks');

    const snapshot: CanonicalLiveSnapshot = {
      segments,
      translations: canonicalizeTranslations(input.translations),
      summaryBlocks,
      status: canonicalizeStatus(input.status, true),
      previewText:
        input.previewText === undefined
          ? { finalText: '', nonFinalText: '' }
          : canonicalizePreviewText(input.previewText),
      previewTranslation:
        input.previewTranslation === undefined
          ? {
              finalText: '',
              nonFinalText: '',
              state: 'idle',
              sourceLanguage: null,
            }
          : canonicalizePreviewTranslation(input.previewTranslation),
      sourceLang: canonicalizeNullableMetadata(input.sourceLang, 'sourceLang'),
      targetLang: canonicalizeNullableMetadata(input.targetLang, 'targetLang'),
      translationMode: canonicalizeTranslationMode(input.translationMode) ?? null,
      updatedAt: nowMs,
    };
    return { ok: true, value: snapshot, bytes: utf8JsonByteLength(snapshot) };
  } catch (error) {
    return {
      ok: false,
      code: 'INVALID_SNAPSHOT',
      message: error instanceof Error ? error.message : 'Invalid live snapshot',
    };
  }
}

export function canonicalizeLiveEvent(
  value: unknown
): LiveSnapshotPolicyResult<CanonicalLiveEvent> {
  try {
    const input = requireRecord(value, 'event');
    const type = requireString(input.type, 'event.type', MAX_METADATA_BYTES);
    const timestamp = requireFiniteNumber(input.timestamp, 'event.timestamp');
    let event: CanonicalLiveEvent;

    switch (type) {
      case 'transcript_delta':
        event = {
          type,
          payload: canonicalizeSegment(input.payload),
          timestamp,
        };
        break;
      case 'translation_delta': {
        const payload = requireRecord(input.payload, 'translation_delta.payload');
        const canonicalPayload: Extract<
          CanonicalLiveEvent,
          { type: 'translation_delta' }
        >['payload'] = {
          segmentId: requireRecordKey(payload.segmentId, 'translation_delta.segmentId'),
          translation: requireString(
            payload.translation,
            'translation_delta.translation',
            MAX_TEXT_BYTES,
            { allowEmpty: true }
          ),
        };
        if (payload.sourceLang !== undefined) {
          canonicalPayload.sourceLang = requireString(
            payload.sourceLang,
            'translation_delta.sourceLang',
            MAX_METADATA_BYTES
          );
        }
        if (payload.targetLang !== undefined) {
          canonicalPayload.targetLang = requireString(
            payload.targetLang,
            'translation_delta.targetLang',
            MAX_METADATA_BYTES
          );
        }
        const translationMode = canonicalizeTranslationMode(payload.translationMode, {
          optional: true,
        });
        if (translationMode !== undefined && translationMode !== null) {
          canonicalPayload.translationMode = translationMode;
        }
        event = { type, payload: canonicalPayload, timestamp };
        break;
      }
      case 'summary_update':
        event = {
          type,
          payload: canonicalizeSummaryBlock(input.payload),
          timestamp,
        };
        break;
      case 'status_update': {
        const payload = requireRecord(input.payload, 'status_update.payload');
        event = {
          type,
          payload: { status: canonicalizeStatus(payload.status, false) as string },
          timestamp,
        };
        break;
      }
      case 'preview_update': {
        const payload = requireRecord(input.payload, 'preview_update.payload');
        event = {
          type,
          payload: {
            previewText: canonicalizePreviewText(payload.previewText),
            previewTranslation: canonicalizePreviewTranslation(
              payload.previewTranslation
            ),
          },
          timestamp,
        };
        break;
      }
      default:
        throw new PolicyViolation('event.type is not allowed');
    }

    return { ok: true, value: event, bytes: utf8JsonByteLength(event) };
  } catch (error) {
    return {
      ok: false,
      code: 'INVALID_EVENT',
      message: error instanceof Error ? error.message : 'Invalid live event',
    };
  }
}

function translationMemberByteLength(key: string, value: string): number {
  return utf8JsonByteLength(key) + 1 + utf8JsonByteLength(value);
}

function createSnapshotRecord(
  ownerId: string,
  snapshot: CanonicalLiveSnapshot,
  bytes: number
): SnapshotRecord {
  const segmentIndexes = new Map<string, number>();
  const segmentBytes = snapshot.segments.map((segment, index) => {
    segmentIndexes.set(segment.id, index);
    return utf8JsonByteLength(segment);
  });
  const translationMemberBytes = new Map<string, number>();
  for (const [key, value] of Object.entries(snapshot.translations)) {
    translationMemberBytes.set(key, translationMemberByteLength(key, value));
  }
  const summaryIndexes = new Map<string, number>();
  const summaryBytes = snapshot.summaryBlocks.map((block, index) => {
    summaryIndexes.set(block.id, index);
    return utf8JsonByteLength(block);
  });
  return {
    ownerId,
    snapshot,
    bytes,
    segmentIndexes,
    segmentBytes,
    translationMemberBytes,
    summaryIndexes,
    summaryBytes,
  };
}

export class LiveSnapshotStore {
  private readonly records = new Map<string, SnapshotRecord>();
  private readonly userBytes = new Map<string, number>();
  private readonly userSessionCounts = new Map<string, number>();
  private totalBytes = 0;
  private readonly limits: SnapshotStoreLimits;

  constructor(limits: Partial<SnapshotStoreLimits> = {}) {
    this.limits = {
      perSessionBytes: limits.perSessionBytes ?? MAX_LIVE_SNAPSHOT_BYTES,
      perUserBytes: limits.perUserBytes ?? MAX_LIVE_SNAPSHOT_BYTES_PER_USER,
      globalBytes: limits.globalBytes ?? MAX_LIVE_SNAPSHOT_BYTES_GLOBAL,
      maxSegments: limits.maxSegments ?? MAX_LIVE_SNAPSHOT_SEGMENTS,
      maxSummaryBlocks:
        limits.maxSummaryBlocks ?? MAX_LIVE_SNAPSHOT_SUMMARY_BLOCKS,
      maxTranslations:
        limits.maxTranslations ?? MAX_LIVE_SNAPSHOT_TRANSLATIONS,
      maxActiveSessionsPerUser:
        limits.maxActiveSessionsPerUser ?? MAX_ACTIVE_LIVE_SNAPSHOTS_PER_USER,
      maxActiveSessionsGlobal:
        limits.maxActiveSessionsGlobal ?? MAX_ACTIVE_LIVE_SNAPSHOTS_GLOBAL,
    };
  }

  get(sessionId: string): CanonicalLiveSnapshot | undefined {
    return this.records.get(sessionId)?.snapshot;
  }

  getOwnerId(sessionId: string): string | undefined {
    return this.records.get(sessionId)?.ownerId;
  }

  getBytes(sessionId: string): number | undefined {
    return this.records.get(sessionId)?.bytes;
  }

  getUserBytes(ownerId: string): number {
    return this.userBytes.get(ownerId) ?? 0;
  }

  getGlobalBytes(): number {
    return this.totalBytes;
  }

  getUserSessionCount(ownerId: string): number {
    return this.userSessionCounts.get(ownerId) ?? 0;
  }

  entries(): IterableIterator<[string, CanonicalLiveSnapshot]> {
    const values = Array.from(this.records, ([sessionId, record]) => [
      sessionId,
      record.snapshot,
    ] as [string, CanonicalLiveSnapshot]);
    return values[Symbol.iterator]();
  }

  private checkBudget(
    sessionId: string,
    ownerId: string,
    nextBytes: number
  ): LiveSnapshotPolicyResult<null> {
    if (nextBytes > this.limits.perSessionBytes) {
      return {
        ok: false,
        code: 'SNAPSHOT_SESSION_LIMIT',
        message: 'Live snapshot exceeds the session byte budget',
        bytes: nextBytes,
        limit: this.limits.perSessionBytes,
      };
    }

    const existing = this.records.get(sessionId);
    const existingOwnerBytes = existing?.ownerId === ownerId ? existing.bytes : 0;
    const nextUserBytes =
      (this.userBytes.get(ownerId) ?? 0) - existingOwnerBytes + nextBytes;
    if (nextUserBytes > this.limits.perUserBytes) {
      return {
        ok: false,
        code: 'SNAPSHOT_USER_LIMIT',
        message: 'Live snapshots exceed the user byte budget',
        bytes: nextUserBytes,
        limit: this.limits.perUserBytes,
      };
    }

    const nextGlobalBytes = this.totalBytes - (existing?.bytes ?? 0) + nextBytes;
    if (nextGlobalBytes > this.limits.globalBytes) {
      return {
        ok: false,
        code: 'SNAPSHOT_GLOBAL_LIMIT',
        message: 'Live snapshots exceed the global byte budget',
        bytes: nextGlobalBytes,
        limit: this.limits.globalBytes,
      };
    }
    return { ok: true, value: null, bytes: nextBytes };
  }

  private commitRecord(sessionId: string, record: SnapshotRecord): void {
    const previous = this.records.get(sessionId);
    if (previous) {
      const previousUserBytes =
        (this.userBytes.get(previous.ownerId) ?? 0) - previous.bytes;
      if (previousUserBytes > 0) {
        this.userBytes.set(previous.ownerId, previousUserBytes);
      } else {
        this.userBytes.delete(previous.ownerId);
      }
      this.totalBytes -= previous.bytes;
    }

    this.records.set(sessionId, record);
    if (!previous) {
      this.userSessionCounts.set(
        record.ownerId,
        (this.userSessionCounts.get(record.ownerId) ?? 0) + 1
      );
    }
    this.userBytes.set(
      record.ownerId,
      (this.userBytes.get(record.ownerId) ?? 0) + record.bytes
    );
    this.totalBytes += record.bytes;
  }

  set(
    sessionId: string,
    ownerId: string,
    snapshot: CanonicalLiveSnapshot
  ): LiveSnapshotPolicyResult<SnapshotSetValue> {
    const existing = this.records.get(sessionId);
    if (existing && existing.ownerId !== ownerId) {
      return {
        ok: false,
        code: 'SNAPSHOT_OWNER_MISMATCH',
        message: 'Live snapshot owner does not match the session owner',
      };
    }
    if (
      snapshot.segments.length > this.limits.maxSegments ||
      snapshot.summaryBlocks.length > this.limits.maxSummaryBlocks ||
      Object.keys(snapshot.translations).length > this.limits.maxTranslations
    ) {
      return {
        ok: false,
        code: 'SNAPSHOT_COUNT_LIMIT',
        message: 'Live snapshot exceeds an aggregate item-count budget',
      };
    }
    if (!existing) {
      if (this.records.size >= this.limits.maxActiveSessionsGlobal) {
        return {
          ok: false,
          code: 'SNAPSHOT_COUNT_LIMIT',
          message: 'Too many active live snapshots globally',
          limit: this.limits.maxActiveSessionsGlobal,
        };
      }
      if (
        (this.userSessionCounts.get(ownerId) ?? 0) >=
        this.limits.maxActiveSessionsPerUser
      ) {
        return {
          ok: false,
          code: 'SNAPSHOT_COUNT_LIMIT',
          message: 'Too many active live snapshots for this user',
          limit: this.limits.maxActiveSessionsPerUser,
        };
      }
    }
    const bytes = utf8JsonByteLength(snapshot);
    const budget = this.checkBudget(sessionId, ownerId, bytes);
    if (!budget.ok) return budget;
    const record = createSnapshotRecord(ownerId, snapshot, bytes);
    this.commitRecord(sessionId, record);
    return {
      ok: true,
      value: { snapshot: record.snapshot, inserted: true },
      bytes,
    };
  }

  setIfAbsent(
    sessionId: string,
    ownerId: string,
    snapshot: CanonicalLiveSnapshot
  ): LiveSnapshotPolicyResult<SnapshotSetValue> {
    const existing = this.records.get(sessionId);
    if (existing) {
      if (existing.ownerId !== ownerId) {
        return {
          ok: false,
          code: 'SNAPSHOT_OWNER_MISMATCH',
          message: 'Live snapshot owner does not match the session owner',
        };
      }
      return {
        ok: true,
        value: { snapshot: existing.snapshot, inserted: false },
        bytes: existing.bytes,
      };
    }
    return this.set(sessionId, ownerId, snapshot);
  }

  applyEvent(
    sessionId: string,
    ownerId: string,
    rawEvent: unknown,
    nowMs = Date.now()
  ): LiveSnapshotPolicyResult<AppliedEventValue> {
    const record = this.records.get(sessionId);
    if (!record) {
      return {
        ok: false,
        code: 'SNAPSHOT_NOT_FOUND',
        message: 'Live snapshot is not initialized',
      };
    }
    if (record.ownerId !== ownerId) {
      return {
        ok: false,
        code: 'SNAPSHOT_OWNER_MISMATCH',
        message: 'Live snapshot owner does not match the broadcaster',
      };
    }

    const parsed = canonicalizeLiveEvent(rawEvent);
    if (!parsed.ok) return parsed;
    const event = parsed.value;
    const nextUpdatedAtBytes = utf8JsonByteLength(nowMs);
    let deltaBytes =
      nextUpdatedAtBytes - utf8JsonByteLength(record.snapshot.updatedAt);
    let commit: () => void;

    switch (event.type) {
      case 'transcript_delta': {
        const nextEntryBytes = utf8JsonByteLength(event.payload);
        const index = record.segmentIndexes.get(event.payload.id);
        if (index === undefined) {
          if (record.snapshot.segments.length >= this.limits.maxSegments) {
            return {
              ok: false,
              code: 'SNAPSHOT_COUNT_LIMIT',
              message: 'Live snapshot has too many transcript segments',
              limit: this.limits.maxSegments,
            };
          }
          deltaBytes +=
            nextEntryBytes + (record.snapshot.segments.length > 0 ? 1 : 0);
          commit = () => {
            const nextIndex = record.snapshot.segments.length;
            record.snapshot.segments.push(event.payload);
            record.segmentIndexes.set(event.payload.id, nextIndex);
            record.segmentBytes.push(nextEntryBytes);
          };
        } else {
          deltaBytes += nextEntryBytes - record.segmentBytes[index];
          commit = () => {
            record.snapshot.segments[index] = event.payload;
            record.segmentBytes[index] = nextEntryBytes;
          };
        }
        break;
      }
      case 'translation_delta': {
        const { segmentId, translation } = event.payload;
        const nextMemberBytes = translationMemberByteLength(segmentId, translation);
        const previousMemberBytes = record.translationMemberBytes.get(segmentId);
        if (previousMemberBytes === undefined) {
          if (
            record.translationMemberBytes.size >= this.limits.maxTranslations
          ) {
            return {
              ok: false,
              code: 'SNAPSHOT_COUNT_LIMIT',
              message: 'Live snapshot has too many translations',
              limit: this.limits.maxTranslations,
            };
          }
          deltaBytes +=
            nextMemberBytes + (record.translationMemberBytes.size > 0 ? 1 : 0);
        } else {
          deltaBytes += nextMemberBytes - previousMemberBytes;
        }

        const nextSourceLang = event.payload.sourceLang;
        const nextTargetLang = event.payload.targetLang;
        const nextTranslationMode = event.payload.translationMode;
        if (nextSourceLang !== undefined) {
          deltaBytes +=
            utf8JsonByteLength(nextSourceLang) -
            utf8JsonByteLength(record.snapshot.sourceLang);
        }
        if (nextTargetLang !== undefined) {
          deltaBytes +=
            utf8JsonByteLength(nextTargetLang) -
            utf8JsonByteLength(record.snapshot.targetLang);
        }
        if (nextTranslationMode !== undefined) {
          deltaBytes +=
            utf8JsonByteLength(nextTranslationMode) -
            utf8JsonByteLength(record.snapshot.translationMode);
        }
        commit = () => {
          record.snapshot.translations[segmentId] = translation;
          record.translationMemberBytes.set(segmentId, nextMemberBytes);
          if (nextSourceLang !== undefined) {
            record.snapshot.sourceLang = nextSourceLang;
          }
          if (nextTargetLang !== undefined) {
            record.snapshot.targetLang = nextTargetLang;
          }
          if (nextTranslationMode !== undefined) {
            record.snapshot.translationMode = nextTranslationMode;
          }
        };
        break;
      }
      case 'summary_update': {
        const nextEntryBytes = utf8JsonByteLength(event.payload);
        const index = record.summaryIndexes.get(event.payload.id);
        if (index === undefined) {
          if (
            record.snapshot.summaryBlocks.length >= this.limits.maxSummaryBlocks
          ) {
            return {
              ok: false,
              code: 'SNAPSHOT_COUNT_LIMIT',
              message: 'Live snapshot has too many summary blocks',
              limit: this.limits.maxSummaryBlocks,
            };
          }
          deltaBytes +=
            nextEntryBytes + (record.snapshot.summaryBlocks.length > 0 ? 1 : 0);
          commit = () => {
            const nextIndex = record.snapshot.summaryBlocks.length;
            record.snapshot.summaryBlocks.push(event.payload);
            record.summaryIndexes.set(event.payload.id, nextIndex);
            record.summaryBytes.push(nextEntryBytes);
          };
        } else {
          deltaBytes += nextEntryBytes - record.summaryBytes[index];
          commit = () => {
            record.snapshot.summaryBlocks[index] = event.payload;
            record.summaryBytes[index] = nextEntryBytes;
          };
        }
        break;
      }
      case 'status_update': {
        deltaBytes +=
          utf8JsonByteLength(event.payload.status) -
          utf8JsonByteLength(record.snapshot.status);
        commit = () => {
          record.snapshot.status = event.payload.status;
        };
        break;
      }
      case 'preview_update': {
        deltaBytes +=
          utf8JsonByteLength(event.payload.previewText) -
          utf8JsonByteLength(record.snapshot.previewText);
        deltaBytes +=
          utf8JsonByteLength(event.payload.previewTranslation) -
          utf8JsonByteLength(record.snapshot.previewTranslation);
        commit = () => {
          record.snapshot.previewText = event.payload.previewText;
          record.snapshot.previewTranslation = event.payload.previewTranslation;
        };
        break;
      }
    }

    const nextBytes = record.bytes + deltaBytes;
    const budget = this.checkBudget(sessionId, ownerId, nextBytes);
    if (!budget.ok) return budget;

    commit();
    record.snapshot.updatedAt = nowMs;
    this.userBytes.set(
      ownerId,
      (this.userBytes.get(ownerId) ?? 0) + deltaBytes
    );
    this.totalBytes += deltaBytes;
    record.bytes = nextBytes;
    return {
      ok: true,
      value: { snapshot: record.snapshot, event },
      bytes: nextBytes,
    };
  }

  delete(sessionId: string): boolean {
    const record = this.records.get(sessionId);
    if (!record) return false;
    this.records.delete(sessionId);
    const nextUserSessionCount =
      (this.userSessionCounts.get(record.ownerId) ?? 0) - 1;
    if (nextUserSessionCount > 0) {
      this.userSessionCounts.set(record.ownerId, nextUserSessionCount);
    } else {
      this.userSessionCounts.delete(record.ownerId);
    }
    const nextUserBytes =
      (this.userBytes.get(record.ownerId) ?? 0) - record.bytes;
    if (nextUserBytes > 0) {
      this.userBytes.set(record.ownerId, nextUserBytes);
    } else {
      this.userBytes.delete(record.ownerId);
    }
    this.totalBytes -= record.bytes;
    return true;
  }

  clear(): void {
    this.records.clear();
    this.userBytes.clear();
    this.userSessionCounts.clear();
    this.totalBytes = 0;
  }
}
