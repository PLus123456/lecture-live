import fs from 'fs/promises';
import path from 'path';
import type { Session } from '@prisma/client';

// 转录稿草稿持久化 — 录制期间实时保存 segments/summaries/translations 到临时目录，
// 结束录制后转存到永久存储并删除草稿。

const DRAFTS_ROOT = path.join(process.cwd(), 'data', 'transcript-drafts');

// P4-5：冲突备份保留份数上限。
// 单调守卫把「段数变少」判为冲突，处理方式是把**整份载荷**写进一个带时间戳的新备份文件并回 200。
// PUT 无限流、单个 segment 体积零校验、落盘还 pretty-print —— 先 PUT 10000 个 1 字节 segment
// 顶满 segmentCount，之后每次 PUT 9999 个巨型 segment 必命中冲突分支，备份文件无限堆积；
// 而 CREATED 会话永不回收，这些文件永久驻留。保留最近 N 份足够事后排查，其余滚动删除。
const MAX_CONFLICT_BACKUPS = 3;

const CONFLICT_BACKUP_RE = /^transcript\.conflict-(\d+)\.json$/;

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

/**
 * 原子写文件：先写同目录临时文件，再 rename 覆盖目标（同分区 rename 是原子操作）。
 * 直接 writeFile 覆写在进程被杀/磁盘满时会留下半截损坏的 JSON，后续 loadTranscriptDraft
 * 解析失败→返回空→auto-reclaim 以空转录落库并删除残稿，草稿永久损毁（审计 medium）。
 * rename 保证读到的永远是完整的旧版或完整的新版，绝不会是半截。
 */
async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`;
  try {
    await fs.writeFile(tmpPath, data, 'utf-8');
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * P4-5：只保留最近 MAX_CONFLICT_BACKUPS 份冲突备份（按文件名里的时间戳降序），其余删除。
 * 目录读不到或删不掉都静默略过 —— 清理失败绝不能影响主草稿的写入语义。
 */
async function pruneConflictBackups(session: DraftSessionSource): Promise<void> {
  const dir = getDraftDir(session);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }

  const backups = entries
    .map((name) => {
      const match = name.match(CONFLICT_BACKUP_RE);
      return match ? { name, ts: Number.parseInt(match[1], 10) } : null;
    })
    .filter((item): item is { name: string; ts: number } => item !== null)
    .sort((a, b) => b.ts - a.ts);

  for (const stale of backups.slice(MAX_CONFLICT_BACKUPS)) {
    await fs.rm(path.join(dir, stale.name), { force: true }).catch(() => {});
  }
}

// L17①：单调守卫的「读 manifest → 比较段数 → 写数据 → 写 manifest」是四步非原子操作。
// 两个并发 PUT（客户端每数秒冲刷一次快照，unload keepalive 还会再来一发）可以都读到同一份
// 旧 manifest、都判定「不缩水、放行」，然后后写者整份覆盖先写者 —— 先写者那一批段直接丢。
// 录音草稿侧（recordingDraftPersistence）早就用 withManifestLock 把这段关进临界区了，转录侧
// 一直没有。注意 writeFileAtomic 的 tmp+rename **治不了这条**：原子写解决的是文件撕裂，
// lost update 与之正交，反而让被覆盖的结果成为一份完整合法的文件、更难察觉。
// 这里按会话排队单写者（同进程内 HTTP 路由与收尾流程共用本模块）。
const draftWriteLocks = new Map<string, Promise<void>>();

async function withDraftLock<T>(
  session: DraftSessionSource,
  fn: () => Promise<T>
): Promise<T> {
  const key = normalizeSessionId(session.id);
  const prev = draftWriteLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 前一个写者失败也必须放行队列，否则一次异常会把该会话的写入永久卡死。
  const chain = prev.then(
    () => current,
    () => current
  );
  draftWriteLocks.set(key, chain);

  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    // 队尾仍是自己 ⇒ 无人排在后面，清掉避免 Map 随会话数无限增长。
    if (draftWriteLocks.get(key) === chain) {
      draftWriteLocks.delete(key);
    }
  }
}

/**
 * L17②：草稿写入被终态守卫拒绝。路由据此回 409 —— 与「seal 之后的迟到写入一律 409」同栅栏。
 */
export class TranscriptDraftRejectedError extends Error {
  constructor(message = 'Transcript draft write rejected by guard') {
    super(message);
    this.name = 'TranscriptDraftRejectedError';
  }
}

export interface PersistTranscriptDraftOptions {
  /**
   * L17②：在**临界区内**、紧贴写盘前后各求值一次的终态守卫。返回 false 表示这次写入已经
   * 不该落盘（会话被 seal / 已 finalize）。
   *
   * 为什么不能只在路由入口查一次：入口查完 seal 之后还要 `req.text()` + `JSON.parse` 一份
   * 最大 8MiB 的载荷，这段时间里 finalize 完全可能跑完（读快照 → 删草稿目录）。此后本次 PUT
   * 会把整个草稿目录**重新创建**出来，而 DELETE 已经过去了 —— 孤儿草稿永久驻留磁盘，冷恢复
   * 还会读到它。写后再查一次并做补偿删除，把这个窗口彻底关掉。
   */
  guard?: () => Promise<boolean>;
}

/** 保存或覆盖转录稿草稿（整体快照） */
export async function persistTranscriptDraft(
  session: DraftSessionSource,
  payload: TranscriptDraftPayload,
  options: PersistTranscriptDraftOptions = {}
): Promise<TranscriptDraftManifest> {
  return withDraftLock(session, () =>
    persistTranscriptDraftLocked(session, payload, options)
  );
}

async function persistTranscriptDraftLocked(
  session: DraftSessionSource,
  payload: TranscriptDraftPayload,
  options: PersistTranscriptDraftOptions
): Promise<TranscriptDraftManifest> {
  // 先过终态守卫再建目录：被拒时连目录都不会创建，不留任何痕迹。
  if (options.guard && !(await options.guard())) {
    throw new TranscriptDraftRejectedError();
  }

  await ensureDraftDir(session);

  const now = Date.now();
  const existing = await loadTranscriptDraftManifest(session);
  const incomingCount = Array.isArray(payload.segments) ? payload.segments.length : 0;

  // 单调守卫：绝不让「更短/重置」的 payload 覆盖掉盘上更完整的草稿。
  // 与音频 chunk 的 seq 续号防覆盖(#19)对称 —— 音频侧新录音从 maxSeq+1 续号不覆盖旧块，
  // 转录侧此前是无守卫的整体替换，一旦刷新后「僵尸录音」从 0 段重新 PUT，就把整份转录盖成
  // 只剩重启后那段。这里命中缩水/重置时：把 incoming 写入带时间戳的 .conflict 备份留档，
  // 主草稿保持更完整的那份不动（备份文件随 deleteTranscriptDraft 整目录清理，不泄漏）。
  // 转录在单次会话与冷恢复续录中都只增不减，故正常写入永远 incomingCount >= 现有段数。
  if (existing && existing.segmentCount > 0 && incomingCount < existing.segmentCount) {
    try {
      await fs.writeFile(
        path.join(getDraftDir(session), `transcript.conflict-${now}.json`),
        JSON.stringify(payload, null, 2),
        'utf-8'
      );
      // P4-5：写完立刻滚动清理，保留最近 MAX_CONFLICT_BACKUPS 份 —— 否则每次冲突 PUT 都留一份
      // 全量副本，无上限增长且随会话永久驻留。
      await pruneConflictBackups(session);
    } catch {
      // 备份失败不阻断：主草稿不动即可，本次 PUT 视为「已保护地忽略」
    }
    console.warn(
      `[transcriptDraft] 拒绝覆盖草稿：incoming ${incomingCount} 段 < 现有 ${existing.segmentCount} 段，` +
        `session=${session.id}，已存 .conflict 备份，主草稿保持不变`
    );
    // L17②：冲突分支同样会（经 ensureDraftDir + 写 .conflict 备份）把目录建回来，补偿检查
    // 一视同仁。
    if (options.guard && !(await options.guard())) {
      await deleteTranscriptDraft(session).catch(() => {});
      throw new TranscriptDraftRejectedError();
    }
    return {
      sessionId: session.id,
      userId: session.userId,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
      segmentCount: existing.segmentCount,
    };
  }

  // 写入完整数据（原子：tmp+rename，避免半截损坏）。先写数据后写 manifest：即便崩在两者
  // 之间，manifest 段数偏小（旧值），只会让单调守卫略保守，不会误导恢复读到不存在的段。
  await writeFileAtomic(
    getDraftDataPath(session),
    JSON.stringify(payload, null, 2)
  );

  // 写入 manifest
  const manifest: TranscriptDraftManifest = {
    sessionId: session.id,
    userId: session.userId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    segmentCount: Array.isArray(payload.segments) ? payload.segments.length : 0,
  };

  await writeFileAtomic(
    getDraftManifestPath(session),
    JSON.stringify(manifest, null, 2)
  );

  // L17②：写后复查。若这期间会话已被 seal / finalize（草稿目录很可能刚被删掉，而我们又把它
  // 建了回来），就地补偿删除并让调用方回 409 —— 绝不留下一份没人会再清理的孤儿草稿。
  if (options.guard && !(await options.guard())) {
    await deleteTranscriptDraft(session).catch(() => {});
    throw new TranscriptDraftRejectedError();
  }

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
