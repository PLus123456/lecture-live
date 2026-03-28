import fs from 'fs/promises';
import path from 'path';
import type { Session } from '@prisma/client';

// 转录稿草稿持久化 — 录制期间实时保存 segments/summaries/translations 到临时目录，
// 结束录制后转存到永久存储并删除草稿。

const DRAFTS_ROOT = path.join(process.cwd(), 'data', 'transcript-drafts');

export interface TranscriptDraftPayload {
  segments: unknown[];
  summaries: unknown[];
  translations: Record<string, string>;
  /** 客户端时间戳，用于冲突检测 */
  clientTs: number;
  /** 录音状态恢复所需的时间信息（浏览器关闭后冷恢复） */
  recordingStartTime?: number;
  pausedAt?: number;
  totalPausedMs?: number;
  totalDurationMs?: number;
  summaryRunningContext?: string;
  currentSessionIndex?: number;
}

export interface TranscriptDraftManifest {
  sessionId: string;
  userId: string;
  createdAt: number;
  updatedAt: number;
  segmentCount: number;
}

type DraftSessionSource = Pick<Session, 'id' | 'userId'>;

function normalizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
}

function getDraftDir(session: DraftSessionSource) {
  return path.join(DRAFTS_ROOT, normalizeSessionId(session.id));
}

function getDraftDataPath(session: DraftSessionSource) {
  return path.join(getDraftDir(session), 'transcript.json');
}

function getDraftManifestPath(session: DraftSessionSource) {
  return path.join(getDraftDir(session), 'manifest.json');
}

async function ensureDraftDir(session: DraftSessionSource) {
  await fs.mkdir(getDraftDir(session), { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 保存或覆盖转录稿草稿（整体快照） */
export async function persistTranscriptDraft(
  session: DraftSessionSource,
  payload: TranscriptDraftPayload
): Promise<TranscriptDraftManifest> {
  await ensureDraftDir(session);

  const now = Date.now();
  const existing = await loadTranscriptDraftManifest(session);

  // 写入完整数据
  await fs.writeFile(
    getDraftDataPath(session),
    JSON.stringify(payload, null, 2),
    'utf-8'
  );

  // 写入 manifest
  const manifest: TranscriptDraftManifest = {
    sessionId: session.id,
    userId: session.userId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    segmentCount: Array.isArray(payload.segments) ? payload.segments.length : 0,
  };

  await fs.writeFile(
    getDraftManifestPath(session),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );

  return manifest;
}

/** 加载草稿 manifest（轻量，不含完整数据） */
export async function loadTranscriptDraftManifest(
  session: DraftSessionSource
): Promise<TranscriptDraftManifest | null> {
  const manifestPath = getDraftManifestPath(session);
  if (!(await fileExists(manifestPath))) {
    return null;
  }

  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TranscriptDraftManifest>;
    if (
      parsed.sessionId !== session.id ||
      parsed.userId !== session.userId ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null;
    }

    return {
      sessionId: parsed.sessionId,
      userId: parsed.userId,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      segmentCount: typeof parsed.segmentCount === 'number' ? parsed.segmentCount : 0,
    };
  } catch {
    return null;
  }
}

/** 加载完整的转录稿草稿数据 */
export async function loadTranscriptDraft(
  session: DraftSessionSource
): Promise<TranscriptDraftPayload | null> {
  const dataPath = getDraftDataPath(session);
  if (!(await fileExists(dataPath))) {
    return null;
  }

  try {
    const raw = await fs.readFile(dataPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TranscriptDraftPayload>;
    return {
      segments: Array.isArray(parsed.segments) ? parsed.segments : [],
      summaries: Array.isArray(parsed.summaries) ? parsed.summaries : [],
      translations:
        parsed.translations && typeof parsed.translations === 'object' && !Array.isArray(parsed.translations)
          ? parsed.translations
          : {},
      clientTs: typeof parsed.clientTs === 'number' ? parsed.clientTs : 0,
      recordingStartTime: typeof parsed.recordingStartTime === 'number' ? parsed.recordingStartTime : undefined,
      pausedAt: typeof parsed.pausedAt === 'number' ? parsed.pausedAt : undefined,
      totalPausedMs: typeof parsed.totalPausedMs === 'number' ? parsed.totalPausedMs : undefined,
      totalDurationMs: typeof parsed.totalDurationMs === 'number' ? parsed.totalDurationMs : undefined,
      summaryRunningContext: typeof parsed.summaryRunningContext === 'string' ? parsed.summaryRunningContext : undefined,
      currentSessionIndex: typeof parsed.currentSessionIndex === 'number' ? parsed.currentSessionIndex : undefined,
    };
  } catch {
    return null;
  }
}

/** 删除转录稿草稿 */
export async function deleteTranscriptDraft(
  session: DraftSessionSource
): Promise<void> {
  await fs.rm(getDraftDir(session), { recursive: true, force: true });
}
