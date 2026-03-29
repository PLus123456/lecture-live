import fs from 'fs/promises';
import path from 'path';
import type { Session } from '@prisma/client';
import {
  CloudreveStorage,
  isCloudreveConfiguredAsync,
  type StorageCategory,
} from '@/lib/storage/cloudreve';

const DATA_ROOT = path.join(process.cwd(), 'data');
const LOCAL_DIRS: Record<StorageCategory, string> = {
  recordings: path.join(DATA_ROOT, 'recordings'),
  transcripts: path.join(DATA_ROOT, 'transcripts'),
  summaries: path.join(DATA_ROOT, 'summaries'),
  reports: path.join(DATA_ROOT, 'reports'),
};

const STATIC_ARTIFACT_EXTENSIONS: Record<
  Exclude<StorageCategory, 'recordings'>,
  string
> = {
  transcripts: 'json',
  summaries: 'json',
  reports: 'json',
};

export interface PersistedTranscriptBundle {
  segments: unknown[];
  summaries: unknown[];
  translations: Record<string, string>;
}

export interface PersistedArtifactResult {
  path: string;
  storage: 'local' | 'cloudreve';
}

export interface LoadedBinaryArtifact {
  data: Buffer;
  fileName: string;
  contentType: string;
  path: string | null;
}

type SessionArtifactsSource = Pick<
  Session,
  'id' | 'userId' | 'recordingPath' | 'transcriptPath' | 'summaryPath'
> & { reportPath?: string | null };

function normalizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
}

function legacyLocalArtifactPath(
  category: StorageCategory,
  sessionId: string
): string {
  return path.join(LOCAL_DIRS[category], artifactFileName(category, sessionId));
}

function buildLocalArtifactPath(
  category: StorageCategory,
  fileName: string
): string {
  return path.join(LOCAL_DIRS[category], path.basename(fileName));
}

function buildLocalArtifactReference(
  category: StorageCategory,
  fileName: string
): string {
  return `local:${category}/${path.basename(fileName)}`;
}

function sanitizeAudioMimeType(mimeType?: string | null): string {
  if (!mimeType) {
    return 'audio/webm';
  }

  const normalized = mimeType.toLowerCase();

  if (normalized.includes('mp4') || normalized.includes('aac')) {
    return 'audio/mp4';
  }

  if (normalized.includes('webm')) {
    return 'audio/webm';
  }

  return 'audio/webm';
}

function recordingExtensionForMimeType(mimeType?: string | null): string {
  return sanitizeAudioMimeType(mimeType) === 'audio/mp4' ? 'mp4' : 'webm';
}

function inferRecordingMimeTypeFromReference(
  reference: string | null | undefined
): string {
  if (!reference) {
    return 'audio/webm';
  }

  const normalized = reference.toLowerCase();

  if (normalized.endsWith('.mp4') || normalized.endsWith('.m4a')) {
    return 'audio/mp4';
  }

  return 'audio/webm';
}

async function ensureLocalDir(category: StorageCategory) {
  await fs.mkdir(LOCAL_DIRS[category], { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseLocalReference(
  category: StorageCategory,
  reference: string,
  sessionId: string
): string | null {
  if (!reference.startsWith('local:')) {
    return null;
  }

  const remainder = reference.slice('local:'.length);
  if (!remainder) {
    return legacyLocalArtifactPath(category, sessionId);
  }

  if (remainder.includes('/')) {
    const [prefix, ...rest] = remainder.split('/');
    if (prefix === category && rest.length > 0) {
      return buildLocalArtifactPath(category, rest.join('/'));
    }
  }

  return buildLocalArtifactPath(category, remainder);
}

async function readArtifactFromReference(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  category: StorageCategory,
  reference: string | null | undefined
): Promise<Buffer | null> {
  const cloudreve = (await isCloudreveConfiguredAsync()) ? await CloudreveStorage.create() : null;
  const defaultCandidates =
    category === 'recordings'
      ? [
          buildLocalArtifactReference(
            category,
            artifactFileName(category, session.id, { mimeType: 'audio/webm' })
          ),
          buildLocalArtifactReference(
            category,
            artifactFileName(category, session.id, { mimeType: 'audio/mp4' })
          ),
        ]
      : [buildLocalArtifactReference(category, artifactFileName(category, session.id))];
  const candidates = reference ? [reference, ...defaultCandidates] : defaultCandidates;

  for (const candidate of candidates) {
    if (candidate.startsWith('local:')) {
      const localPath = parseLocalReference(category, candidate, session.id);
      if (!localPath) {
        continue;
      }
      if (await fileExists(localPath)) {
        return fs.readFile(localPath);
      }
      continue;
    }

    if (cloudreve && candidate.startsWith('/')) {
      try {
        return await cloudreve.downloadByRemotePath(candidate, session.userId);
      } catch {
        continue;
      }
    }
  }

  return null;
}

function artifactFileName(
  category: StorageCategory,
  sessionId: string,
  options?: { mimeType?: string | null }
): string {
  if (category === 'recordings') {
    return `${normalizeSessionId(sessionId)}.${recordingExtensionForMimeType(
      options?.mimeType
    )}`;
  }

  return `${normalizeSessionId(sessionId)}.${STATIC_ARTIFACT_EXTENSIONS[category]}`;
}

async function persistArtifact(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  category: StorageCategory,
  data: Buffer | string,
  options?: { mimeType?: string | null }
): Promise<PersistedArtifactResult> {
  const fileName = artifactFileName(category, session.id, options);

  await ensureLocalDir(category);
  await fs.writeFile(buildLocalArtifactPath(category, fileName), data);

  const localReference = buildLocalArtifactReference(category, fileName);
  if (!(await isCloudreveConfiguredAsync())) {
    return { path: localReference, storage: 'local' };
  }

  const storage = await CloudreveStorage.create();
  const remotePath = await storage.upload(session.userId, category, fileName, data);
  return { path: remotePath, storage: 'cloudreve' };
}

export async function persistSessionAudioArtifact(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  data: Buffer,
  mimeType?: string | null
): Promise<PersistedArtifactResult> {
  return persistArtifact(session, 'recordings', data, { mimeType });
}

export async function persistSessionTranscriptArtifacts(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  bundle: PersistedTranscriptBundle
): Promise<{
  transcript: PersistedArtifactResult;
  summary: PersistedArtifactResult;
}> {
  const transcriptJson = JSON.stringify(bundle, null, 2);
  const summaryJson = JSON.stringify(bundle.summaries, null, 2);

  const [transcript, summary] = await Promise.all([
    persistArtifact(session, 'transcripts', transcriptJson),
    persistArtifact(session, 'summaries', summaryJson),
  ]);

  return { transcript, summary };
}

export async function loadSessionTranscriptBundle(
  session: SessionArtifactsSource
): Promise<PersistedTranscriptBundle | null> {
  const transcriptBuffer = await readArtifactFromReference(
    session,
    'transcripts',
    session.transcriptPath
  );

  if (!transcriptBuffer) {
    return null;
  }

  const parsed = safeParseJson(transcriptBuffer.toString('utf-8'));
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const record = parsed as Partial<PersistedTranscriptBundle>;
  const fallbackSummaries = await loadSessionSummaryData(session);

  return {
    segments: Array.isArray(record.segments) ? record.segments : [],
    summaries: Array.isArray(record.summaries)
      ? record.summaries
      : fallbackSummaries ?? [],
    translations: isPlainObject(record.translations)
      ? sanitizeStringRecord(record.translations)
      : {},
  };
}

export async function loadSessionSummaryData(
  session: SessionArtifactsSource
): Promise<unknown[] | null> {
  const summaryBuffer = await readArtifactFromReference(
    session,
    'summaries',
    session.summaryPath
  );

  if (!summaryBuffer) {
    return null;
  }

  const parsed = safeParseJson(summaryBuffer.toString('utf-8'));
  return Array.isArray(parsed) ? parsed : null;
}

export async function loadSessionAudioArtifact(
  session: SessionArtifactsSource
): Promise<LoadedBinaryArtifact | null> {
  const audioBuffer = await readArtifactFromReference(
    session,
    'recordings',
    session.recordingPath
  );

  if (!audioBuffer) {
    return null;
  }

  const inferredMimeType = session.recordingPath
    ? inferRecordingMimeTypeFromReference(session.recordingPath)
    : (await fileExists(
        buildLocalArtifactPath(
          'recordings',
          artifactFileName('recordings', session.id, { mimeType: 'audio/mp4' })
        )
      ))
      ? 'audio/mp4'
      : 'audio/webm';

  return {
    data: audioBuffer,
    fileName: artifactFileName('recordings', session.id, {
      mimeType: inferredMimeType,
    }),
    contentType: inferredMimeType,
    path:
      session.recordingPath ??
      buildLocalArtifactReference(
        'recordings',
        artifactFileName('recordings', session.id, {
          mimeType: inferredMimeType,
        })
      ),
  };
}

export function extractTranscriptText(bundle: PersistedTranscriptBundle): string {
  return bundle.segments
    .map((segment) => {
      if (!segment || typeof segment !== 'object') {
        return '';
      }

      const text = (segment as { text?: unknown }).text;
      return typeof text === 'string' ? text.trim() : '';
    })
    .filter(Boolean)
    .join('\n');
}

function safeParseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeStringRecord(
  value: Record<string, unknown>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => typeof entry === 'string')
      .map(([key, entry]) => [key, entry as string])
  );
}

/** 保存会话报告 */
export async function persistSessionReport(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  report: unknown
): Promise<PersistedArtifactResult> {
  const json = JSON.stringify(report, null, 2);
  return persistArtifact(session, 'reports', json);
}

/** 加载会话报告 */
export async function loadSessionReport(
  session: SessionArtifactsSource
): Promise<unknown | null> {
  const buffer = await readArtifactFromReference(
    session,
    'reports',
    session.reportPath
  );
  if (!buffer) return null;
  return safeParseJson(buffer.toString('utf-8'));
}
