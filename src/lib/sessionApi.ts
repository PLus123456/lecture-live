import type { StorageCategory } from '@/lib/storage/cloudreve';
import type { PersistedTranscriptBundle } from '@/lib/sessionPersistence';

const SESSION_AUDIO_SOURCES = ['microphone', 'system_audio'] as const;
const SESSION_REGIONS = ['auto', 'us', 'eu', 'jp'] as const;
const SESSION_EXPORT_FORMATS = ['markdown', 'srt', 'json', 'txt'] as const;

export type SessionAudioSource = (typeof SESSION_AUDIO_SOURCES)[number];
export type SessionRegion = (typeof SESSION_REGIONS)[number];
export type SessionExportFormat = (typeof SESSION_EXPORT_FORMATS)[number];

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

export function normalizeLanguageCode(
  value: unknown,
  fallback: string
): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return normalized ? normalized.slice(0, 16) : fallback;
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
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as {
    segments?: unknown;
    summaries?: unknown;
    translations?: unknown;
  };

  if (
    !Array.isArray(record.segments) ||
    !Array.isArray(record.summaries) ||
    !isStringRecord(record.translations)
  ) {
    return null;
  }

  return {
    segments: record.segments,
    summaries: record.summaries,
    translations: record.translations,
  };
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

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
}
