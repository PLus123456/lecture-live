import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import path from 'path';
import crypto from 'crypto';
import type { Session } from '@prisma/client';
import {
  CloudreveStorage,
  type SessionArtifactCategory,
} from '@/lib/storage/cloudreve';
import {
  loadCloudreveContext,
  deleteCloudreveFile,
  type CloudreveDeleteContext,
} from '@/lib/storage/cloudreveFileDelete';
import { logger, serializeError } from '@/lib/logger';

const DATA_ROOT = path.join(process.cwd(), 'data');
const LOCAL_DIRS: Record<SessionArtifactCategory, string> = {
  recordings: path.join(DATA_ROOT, 'recordings'),
  transcripts: path.join(DATA_ROOT, 'transcripts'),
  summaries: path.join(DATA_ROOT, 'summaries'),
  reports: path.join(DATA_ROOT, 'reports'),
  // 完整版补全转录：与实时 transcripts 完全分离的独立类别，落 data/full-transcripts/{id}.json。
  'full-transcripts': path.join(DATA_ROOT, 'full-transcripts'),
};

const STATIC_ARTIFACT_EXTENSIONS: Record<
  Exclude<SessionArtifactCategory, 'recordings'>,
  string
> = {
  transcripts: 'json',
  summaries: 'json',
  reports: 'json',
  'full-transcripts': 'json',
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
> & {
  reportPath?: string | null;
  fullTranscriptPath?: string | null;
  enhancedAudioPath?: string | null;
};

function normalizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
}

function legacyLocalArtifactPath(
  category: SessionArtifactCategory,
  sessionId: string
): string {
  return path.join(LOCAL_DIRS[category], artifactFileName(category, sessionId));
}

function buildLocalArtifactPath(
  category: SessionArtifactCategory,
  fileName: string
): string {
  return path.join(LOCAL_DIRS[category], path.basename(fileName));
}

function buildLocalArtifactReference(
  category: SessionArtifactCategory,
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

  // C15: 保留 mp3/wav/ogg 真实容器类型，避免把异步上传转码产物(audio/mpeg)与
  // wav/ogg 直传一律塌成 audio/webm 导致导出/下载文件名后缀与真实字节不符、被
  // 严格外部播放器拒收。in-app 回放靠 blob 内容嗅探不受影响，但存储/HTTP 头需正确。
  if (normalized.includes('mpeg') || normalized.includes('mp3')) {
    return 'audio/mpeg';
  }

  if (normalized.includes('wav') || normalized.includes('wave')) {
    return 'audio/wav';
  }

  if (normalized.includes('ogg')) {
    return 'audio/ogg';
  }

  if (normalized.includes('webm')) {
    return 'audio/webm';
  }

  return 'audio/webm';
}

const AUDIO_MIME_TO_EXTENSION: Record<string, string> = {
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
};

function recordingExtensionForMimeType(mimeType?: string | null): string {
  return AUDIO_MIME_TO_EXTENSION[sanitizeAudioMimeType(mimeType)] ?? 'webm';
}

export function inferRecordingMimeTypeFromReference(
  reference: string | null | undefined
): string {
  if (!reference) {
    return 'audio/webm';
  }

  const normalized = reference.toLowerCase();

  if (normalized.endsWith('.mp4') || normalized.endsWith('.m4a')) {
    return 'audio/mp4';
  }

  if (normalized.endsWith('.mp3') || normalized.endsWith('.mpeg')) {
    return 'audio/mpeg';
  }

  if (normalized.endsWith('.wav')) {
    return 'audio/wav';
  }

  if (normalized.endsWith('.ogg') || normalized.endsWith('.oga')) {
    return 'audio/ogg';
  }

  return 'audio/webm';
}

async function ensureLocalDir(category: SessionArtifactCategory) {
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

async function getCloudreveStorageIfConfigured(): Promise<CloudreveStorage | null> {
  try {
    return await CloudreveStorage.create();
  } catch {
    return null;
  }
}

function parseLocalReference(
  category: SessionArtifactCategory,
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

export async function readArtifactFromReference(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  category: SessionArtifactCategory,
  reference: string | null | undefined
): Promise<Buffer | null> {
  let cloudreve: CloudreveStorage | null | undefined;
  const defaultCandidates =
    category === 'recordings'
      ? ([
          'audio/webm',
          'audio/mp4',
          'audio/mpeg',
          'audio/wav',
          'audio/ogg',
        ] as const).map((mimeType) =>
          buildLocalArtifactReference(
            category,
            artifactFileName(category, session.id, { mimeType })
          )
        )
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

    if (candidate.startsWith('/')) {
      if (cloudreve === undefined) {
        cloudreve = await getCloudreveStorageIfConfigured();
      }

      if (!cloudreve) {
        continue;
      }

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
  category: SessionArtifactCategory,
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

async function inferLocalRecordingMimeType(sessionId: string): Promise<string> {
  const orderedMimeTypes = [
    'audio/mp4',
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
  ] as const;
  for (const mimeType of orderedMimeTypes) {
    const exists = await fileExists(
      buildLocalArtifactPath(
        'recordings',
        artifactFileName('recordings', sessionId, { mimeType })
      )
    );
    if (exists) {
      return mimeType;
    }
  }
  return 'audio/webm';
}

const persistenceLogger = logger.child({ component: 'session-persistence' });

/**
 * best-effort 物理删除一条 artifact 引用（本地文件或 Cloudreve 远程文件）。
 * reference 形如 `local:{category}/{fileName}`（本地）或 `/{userId}/{category}/{fileName}`
 * （Cloudreve 远程路径，以 `/` 开头）。任何失败仅 warn、绝不抛。
 */
async function deleteArtifactByReference(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  category: SessionArtifactCategory,
  reference: string | null | undefined,
  cloudreveCtx?: CloudreveDeleteContext | null
): Promise<void> {
  if (!reference) {
    return;
  }

  if (reference.startsWith('local:')) {
    const localPath = parseLocalReference(category, reference, session.id);
    if (localPath) {
      await fs.rm(localPath, { force: true }).catch((err) => {
        persistenceLogger.warn(
          { localPath, err: serializeError(err) },
          '删除本地 artifact 失败；残留由清理工具兜底'
        );
      });
    }
    return;
  }

  if (reference.startsWith('/')) {
    const ctx =
      cloudreveCtx === undefined ? await loadCloudreveContext() : cloudreveCtx;
    if (!ctx) {
      return;
    }
    await deleteCloudreveFile(reference, ctx);
  }
}

export async function persistArtifact(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  category: SessionArtifactCategory,
  data: Buffer | string,
  options?: { mimeType?: string | null; previousReference?: string | null }
): Promise<PersistedArtifactResult> {
  const fileName = artifactFileName(category, session.id, options);

  await ensureLocalDir(category);
  await fs.writeFile(buildLocalArtifactPath(category, fileName), data);

  const localReference = buildLocalArtifactReference(category, fileName);
  const storage = await getCloudreveStorageIfConfigured();
  const result: PersistedArtifactResult = storage
    ? {
        path: await storage.upload(session.userId, category, fileName, data),
        storage: 'cloudreve',
      }
    : { path: localReference, storage: 'local' };

  // G5/G6：换容器格式重传/草稿定稿会写入不同后缀的新文件；若旧 recordingPath 指向的
  // 物理文件与新文件不同（本地路径或 Cloudreve 远程路径不一致），best-effort 删旧物理文件，
  // 避免本地盘 + Cloudreve 永久孤儿。remotePath/localReference 均可稳定比较。
  const previous = options?.previousReference;
  if (previous && previous !== result.path && previous !== localReference) {
    // 同时清掉与新引用不同的旧本地文件（Cloudreve 上传后本地也保留了一份新文件，
    // 旧本地文件仍需单独删）。
    await deleteArtifactByReference(session, category, previous);
  }

  return result;
}

export async function persistSessionAudioArtifact(
  session: Pick<SessionArtifactsSource, 'id' | 'userId' | 'recordingPath'>,
  data: Buffer,
  mimeType?: string | null
): Promise<PersistedArtifactResult> {
  return persistArtifact(session, 'recordings', data, {
    mimeType,
    previousReference: session.recordingPath,
  });
}

// ── P0-6：artifact 临时对象 + CAS 发布 ─────────────────────────────────────────
// 旧的 persistArtifact 先物理覆盖固定 key `{sessionId}.{ext}` 并删旧文件，再由调用方做
// 数据库状态 guard。并发 finalize 已完成时，路由虽返回 409，但终态物理文件已被覆盖/删除
// （审计 P0-6 问题 A）。下面把写入拆成两阶段：
//   ① stageArtifact —— 写「版本化对象」（唯一文件名，绝不覆盖旧文件），拿到其引用；
//   ② 调用方在事务里 CAS（updateMany 判 count）把 path 指向该引用；
//   ③ CAS 成功 → finalizeStagedArtifactPublish（删旧 previousReference）；
//      CAS 失败 → rollbackStagedArtifact（删掉刚写的版本化对象，绝不动旧 artifact）。

export interface StagedArtifact {
  category: SessionArtifactCategory;
  // 已发布对象的引用；数据库 CAS 应写入此值。
  reference: string;
  // 本地版本化文件引用（Cloudreve 模式下本地也留一份，回滚/比较需单独处理）。
  localReference: string;
  storage: 'local' | 'cloudreve';
  previousReference?: string | null;
}

function buildVersionedArtifactFileName(
  category: SessionArtifactCategory,
  sessionId: string,
  options?: { mimeType?: string | null }
): string {
  // 版本化后缀：时间戳 + 随机，保证与最终 key 及旧文件都不同名；扩展名保持在末位，
  // 使 inferRecordingMimeTypeFromReference 的按后缀嗅探仍成立。
  const stamp = `${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
  const base = normalizeSessionId(sessionId);
  if (category === 'recordings') {
    return `${base}-${stamp}.${recordingExtensionForMimeType(options?.mimeType)}`;
  }
  return `${base}-${stamp}.${STATIC_ARTIFACT_EXTENSIONS[category]}`;
}

export async function stageArtifact(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  category: SessionArtifactCategory,
  data: Buffer | string,
  options?: { mimeType?: string | null; previousReference?: string | null }
): Promise<StagedArtifact> {
  const fileName = buildVersionedArtifactFileName(category, session.id, options);
  await ensureLocalDir(category);
  await fs.writeFile(buildLocalArtifactPath(category, fileName), data);

  const localReference = buildLocalArtifactReference(category, fileName);
  const storage = await getCloudreveStorageIfConfigured();
  if (storage) {
    const remotePath = await storage.upload(session.userId, category, fileName, data);
    return {
      category,
      reference: remotePath,
      localReference,
      storage: 'cloudreve',
      previousReference: options?.previousReference ?? null,
    };
  }
  return {
    category,
    reference: localReference,
    localReference,
    storage: 'local',
    previousReference: options?.previousReference ?? null,
  };
}

export async function stageSessionAudioArtifact(
  session: Pick<SessionArtifactsSource, 'id' | 'userId' | 'recordingPath'>,
  data: Buffer,
  mimeType?: string | null
): Promise<StagedArtifact> {
  return stageArtifact(session, 'recordings', data, {
    mimeType,
    previousReference: session.recordingPath,
  });
}

/** P0-6：CAS 成功后发布 —— best-effort 删旧 previousReference，返回最终 PersistedArtifactResult。 */
export async function finalizeStagedArtifactPublish(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  staged: StagedArtifact
): Promise<PersistedArtifactResult> {
  const previous = staged.previousReference;
  if (
    previous &&
    previous !== staged.reference &&
    previous !== staged.localReference
  ) {
    await deleteArtifactByReference(session, staged.category, previous);
  }
  return { path: staged.reference, storage: staged.storage };
}

/** P0-6：CAS 失败回滚 —— 删掉刚写的版本化对象（本地 + 可能的 Cloudreve），绝不动旧 artifact。 */
export async function rollbackStagedArtifact(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  staged: StagedArtifact
): Promise<void> {
  if (staged.storage === 'cloudreve' && staged.reference !== staged.localReference) {
    await deleteArtifactByReference(session, staged.category, staged.reference).catch(
      () => undefined
    );
  }
  await deleteArtifactByReference(
    session,
    staged.category,
    staged.localReference
  ).catch(() => undefined);
}

/**
 * U4：best-effort 物理删除一个会话的全部产物（本地 data/ + Cloudreve 远程），
 * 覆盖录音/转录/摘要/报告/完整版转录。删 session 行前调用（行一删便再无 path→owner 关联）。
 * 单次加载 Cloudreve 上下文复用。任何失败仅 warn，绝不阻塞 DB 删除。
 */
export async function deleteSessionArtifacts(
  session: SessionArtifactsSource
): Promise<void> {
  const ctx = await loadCloudreveContext();
  const targets: Array<[SessionArtifactCategory, string | null | undefined]> = [
    ['recordings', session.recordingPath],
    // 音频增强产物与原录音同在 recordings 类别下（版本化文件名），需单独一条清理
    ['recordings', session.enhancedAudioPath],
    ['transcripts', session.transcriptPath],
    ['summaries', session.summaryPath],
    ['reports', session.reportPath],
    // C3：完整版补全转录产物（本地 data/full-transcripts/ 或 Cloudreve 远程），
    // 与其它产物一并清理，删会话不留孤儿。fullTranscriptPath 为空则被 deleteArtifactByReference 跳过。
    ['full-transcripts', session.fullTranscriptPath],
  ];
  for (const [category, reference] of targets) {
    await deleteArtifactByReference(session, category, reference, ctx);
  }
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

/**
 * P0-6：转录 + 摘要的两阶段写入。先写版本化临时对象；调用方 DB CAS 成功后
 * finalizeStagedArtifactPublish、失败 rollbackStagedArtifact。转录/摘要不追踪 previousReference
 * （旧行为即覆盖固定 key），故发布仅返回引用、无旧文件可删。
 */
export async function stageSessionTranscriptArtifacts(
  session: Pick<SessionArtifactsSource, 'id' | 'userId'>,
  bundle: PersistedTranscriptBundle
): Promise<{ transcript: StagedArtifact; summary: StagedArtifact }> {
  const transcriptJson = JSON.stringify(bundle, null, 2);
  const summaryJson = JSON.stringify(bundle.summaries, null, 2);

  const [transcript, summary] = await Promise.all([
    stageArtifact(session, 'transcripts', transcriptJson),
    stageArtifact(session, 'summaries', summaryJson),
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
    : await inferLocalRecordingMimeType(session.id);

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

// ── P2-2：录音 Range 流式读取（本地按 range 读、Cloudreve 用上游 range/stream）───────────────
// 旧的播放/分享路由先 loadSessionAudioArtifact 把整段录音读进内存再 subarray 出 Range，长录音 +
// 并发 Range 请求会放大进程内存直至 OOM。下面把「定位录音物理位置」与「按 range 流式取字节」拆开：
//   resolveSessionAudioLocation —— 解析到本地文件（路径+大小+MIME）或 Cloudreve 远程路径；
//   openLocalAudioRangeStream   —— 本地文件按 [start,end] 用 createReadStream 流式读，不整包入内存；
//   Cloudreve 分支由路由调用 storage.openDownloadStream({range}) 透传上游 206/流，同样不入内存。

export type SessionAudioLocation =
  | { kind: 'local'; filePath: string; size: number; contentType: string }
  | { kind: 'cloudreve'; remotePath: string; userId: string; contentType: string };

/**
 * P2-2：解析会话录音的物理位置，供 Range 路由流式读取。候选顺序与 readArtifactFromReference 一致：
 * 先显式 recordingPath，再按容器类型的默认本地候选。命中本地文件返回其路径/大小/按扩展名推断的
 * MIME；命中 Cloudreve 远程路径（以 '/' 开头）返回远程路径，由调用方 openDownloadStream 透传 range。
 */
export async function resolveSessionAudioLocation(
  session: Pick<SessionArtifactsSource, 'id' | 'userId' | 'recordingPath'>
): Promise<SessionAudioLocation | null> {
  const reference = session.recordingPath;
  const defaultCandidates = (
    ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg'] as const
  ).map((mimeType) =>
    buildLocalArtifactReference(
      'recordings',
      artifactFileName('recordings', session.id, { mimeType })
    )
  );
  const candidates = reference ? [reference, ...defaultCandidates] : defaultCandidates;

  for (const candidate of candidates) {
    if (candidate.startsWith('local:')) {
      const localPath = parseLocalReference('recordings', candidate, session.id);
      if (localPath && (await fileExists(localPath))) {
        const stat = await fs.stat(localPath);
        return {
          kind: 'local',
          filePath: localPath,
          size: stat.size,
          contentType: inferRecordingMimeTypeFromReference(candidate),
        };
      }
      continue;
    }

    if (candidate.startsWith('/')) {
      return {
        kind: 'cloudreve',
        remotePath: candidate,
        userId: session.userId,
        contentType: inferRecordingMimeTypeFromReference(candidate),
      };
    }
  }

  return null;
}

/**
 * P2-2：以 Web ReadableStream 打开本地录音文件的一段字节（start/end 均为**包含**，与 HTTP Range
 * 语义一致；createReadStream 的 end 亦为包含）。省略 range 即整文件流式读取。不把文件读进内存。
 */
export function openLocalAudioRangeStream(
  filePath: string,
  range?: { start: number; end: number }
): ReadableStream<Uint8Array> {
  const nodeStream = range
    ? createReadStream(filePath, { start: range.start, end: range.end })
    : createReadStream(filePath);
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
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
