// src/lib/liveShare/server.ts
// 服务端 socket.io 实时分享逻辑

import fs from 'node:fs/promises';
import path from 'path';
import { Server as SocketIO, Socket } from 'socket.io';
import { prisma } from '@/lib/prisma';
import { assertWithinRoot, sanitizePath, sanitizeToken } from '@/lib/security';
import { logger, serializeError } from '@/lib/logger';
import {
  CLIENT_SESSION_TOKEN,
  diagnoseEstablishedAuthFamilyToken,
  extractTokenFromCookieHeader,
  verifyAuthToken,
} from '@/lib/auth';
import {
  BoundedJsonFileError,
  readJsonFileBounded,
} from './boundedJsonFile';
import {
  canonicalizeLiveSnapshot,
  createEmptyLiveSnapshot,
  LiveSnapshotStore,
  MAX_LIVE_INITIAL_STATE_BYTES_PER_SOCKET,
  MAX_LIVE_PERSISTED_JSON_BYTES,
  MAX_LIVE_SNAPSHOT_BYTES,
  socketIoEventByteLength,
  type CanonicalLiveSnapshot,
  type LiveSnapshotPolicyErrorCode,
} from './snapshotPolicy';
import {
  consumeViewerJoinAttempt,
  createViewerInitialStateBudget,
  createViewerJoinRateState,
  parseViewerJoinToken,
  reserveViewerInitialStateBytes,
} from './viewerJoinPolicy';
import { LiveSnapshotGenerationRegistry } from './snapshotGeneration';

const TRANSCRIPT_DIR = path.join(process.cwd(), 'data', 'transcripts');
const TRANSCRIPT_DRAFT_DIR = path.join(
  process.cwd(),
  'data',
  'transcript-drafts'
);
const liveShareLogger = logger.child({ component: 'live-share' });

interface BroadcasterAuthPayload {
  token?: string;
  sessionId?: string;
  shareToken?: string;
}

interface EstablishedBroadcasterContext {
  rawJwt: string;
  sessionId: string;
  userId: string;
  shareToken: string;
  shareLinkId: string;
  snapshotGenerationId: string;
  snapshotGenerationChanged: boolean;
}

class BroadcasterAuthLeafExpiredError extends Error {
  constructor() {
    super('Broadcaster authentication leaf expired');
    this.name = 'BroadcasterAuthLeafExpiredError';
  }
}

interface ActiveBroadcaster {
  revalidate: (options?: { silent?: boolean }) => Promise<boolean>;
}

type BroadcasterRegistry = Map<string, Map<string, ActiveBroadcaster>>;

// 内部撤销 HTTP handler 只有 io 实例；用 WeakMap 关联当前进程内的已认证主持人闭包，
// raw JWT 只留在闭包，不写 socket.data，也不会被 adapter/fetchSockets 序列化出去。
const activeBroadcastersByServer = new WeakMap<SocketIO, BroadcasterRegistry>();

type LiveSnapshot = CanonicalLiveSnapshot;

const snapshots = new LiveSnapshotStore();
interface SnapshotLoadEntry {
  generationId: string;
  promise: Promise<LiveSnapshot>;
}

const snapshotLoadPromises = new Map<string, SnapshotLoadEntry>();
// ShareLink.id 是当前直播分享世代。新链接接管同一 session 时先清掉旧世代的内存/读盘，
// 防止已撤权 A 主持人的历史或迟到 promise 泄漏给 B 链接的新观众。
const snapshotGenerations = new LiveSnapshotGenerationRegistry();

function activateSnapshotGeneration(
  sessionId: string,
  linkId: string
): { generationId: string; changed: boolean } {
  const activated = snapshotGenerations.activate(sessionId, linkId);
  if (activated.changed) {
    snapshots.delete(sessionId);
    snapshotLoadPromises.delete(sessionId);
  }
  return activated;
}

function isActiveSnapshotGeneration(
  sessionId: string,
  generationId: string
): boolean {
  return snapshotGenerations.isActive(sessionId, generationId);
}

/** expectedGeneration 不匹配表示新世代已接管；绝不能让旧连接删除新世代状态。 */
function invalidateSnapshotGeneration(
  sessionId: string,
  expectedGeneration?: string
): boolean {
  if (!snapshotGenerations.invalidate(sessionId, expectedGeneration)) {
    return false;
  }
  snapshots.delete(sessionId);
  snapshotLoadPromises.delete(sessionId);
  return true;
}

// C3/U11：主播 socket 断开时不立即宣告下线，先给一段宽限期。若主播在窗口内重连
// （Wi-Fi 切换 / ping 超时导致的瞬断），取消宣告并保留内存快照；只有窗口内未回来
// 才真正广播 SHARE_OFFLINE 并回收快照。intentional stop 走的是 broadcast 事件路径
// （broadcaster.broadcastStatusUpdate('SHARE_OFFLINE') 在 disconnect 之前发出），
// 不依赖此处，故加宽限期不会拖慢主动结束的下线提示。
const HOST_OFFLINE_GRACE_MS = 15_000;
const pendingHostOffline = new Map<string, NodeJS.Timeout>();

function cancelPendingHostOffline(sessionId: string) {
  const timer = pendingHostOffline.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    pendingHostOffline.delete(sessionId);
  }
}

// U61：观众 join 仅凭持久化的 shareLink.isLive 即可在 snapshots 里落一条（此时主播
// 可能从未连上本进程），而唯一的清理只在主播 socket 断开时触发；这类"无主播"条目会
// 永久驻留，WS 进程内存单调增长。用 updatedAt 驱动的后台清扫兜底：定期删除长期无活动
// 且房间内已无任何 socket 的条目（有观众在看则保留，避免刚建的条目被误删）。
const SNAPSHOT_TTL_MS = 30 * 60_000; // 30 分钟无更新
const SNAPSHOT_SWEEP_INTERVAL_MS = 5 * 60_000; // 每 5 分钟扫一次

async function sweepStaleSnapshots(io: SocketIO) {
  const now = Date.now();
  for (const [sessionId, snapshot] of snapshots.entries()) {
    if (now - snapshot.updatedAt < SNAPSHOT_TTL_MS) {
      continue;
    }
    const expectedGeneration = snapshotGenerations.getActiveGenerationId(sessionId);
    if (!expectedGeneration) continue;
    // 房间内仍有 socket（观众/主播）则保留；仅回收确无成员的僵尸条目。
    let roomEmpty = false;
    try {
      const roomSockets = await io.in(getRoomId(sessionId)).fetchSockets();
      roomEmpty = roomSockets.length === 0;
    } catch {
      continue;
    }
    if (roomEmpty && !pendingHostOffline.has(sessionId)) {
      // fetchSockets 期间可能已有新分享世代接管；只允许回收扫描开始时看到的旧世代。
      if (invalidateSnapshotGeneration(sessionId, expectedGeneration)) {
        liveShareLogger.info(
          { sessionId, ageMs: now - snapshot.updatedAt },
          'Reclaimed stale live snapshot with no active room members'
        );
      }
    }
  }
}

function getRoomId(sessionId: string) {
  return `live:${sessionId}`;
}

function stripBearerPrefix(token: string) {
  return token.startsWith('Bearer ') ? token.slice(7) : token;
}

function resolveSocketJwt(socket: Socket, authToken?: string) {
  const bearerToken = authToken ? stripBearerPrefix(authToken) : '';
  if (bearerToken && bearerToken !== CLIENT_SESSION_TOKEN) {
    return bearerToken;
  }

  return extractTokenFromCookieHeader(socket.handshake.headers.cookie);
}

function readSessionTranscriptPath(sessionId: string) {
  const safeSessionId = sanitizePath(sessionId);
  const fullPath = path.join(TRANSCRIPT_DIR, `${safeSessionId}.json`);
  assertWithinRoot(fullPath, TRANSCRIPT_DIR);
  return fullPath;
}

/**
 * 定位会话最新的转录稿草稿文件。
 *
 * transcriptDraftPersistence 写的是 `transcript-<uuid>.json`（每次落盘换一个代号，
 * tmp+rename 原子发布），裸 `transcript.json` 只是升级前的历史文件名。硬编码后者会让
 * 冷启动恢复对**这次部署之后写的每一份草稿**都 ENOENT —— 观众在主持人第一帧
 * sync_snapshot 之前进来、或 WS 进程中途重启，看到的就是一块空白板。
 *
 * 这里只做目录列举 + 取最新，不走账本：WS 进程因此不依赖 StoredArtifact 是否已回填，
 * 读取本身仍是有界的，磁盘副本照样过同一套 canonical/字节预算。
 */
async function resolveSessionTranscriptDraftPath(
  sessionId: string
): Promise<string> {
  const safeSessionId = sanitizePath(sessionId);
  const dir = path.join(TRANSCRIPT_DRAFT_DIR, safeSessionId);
  assertWithinRoot(dir, TRANSCRIPT_DRAFT_DIR);

  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const candidates = entries.filter(
    (name) => name === 'transcript.json' || /^transcript-[\w.-]+\.json$/.test(name)
  );
  if (candidates.length === 0) {
    // 让调用方的 catch 拿到一致的 ENOENT 语义。
    const legacy = path.join(dir, 'transcript.json');
    assertWithinRoot(legacy, TRANSCRIPT_DRAFT_DIR);
    return legacy;
  }

  let newestPath = '';
  let newestAt = -Infinity;
  for (const name of candidates) {
    const candidate = path.join(dir, name);
    assertWithinRoot(candidate, TRANSCRIPT_DRAFT_DIR);
    const stat = await fs.stat(candidate).catch(() => null);
    if (!stat?.isFile()) continue;
    if (stat.mtimeMs > newestAt) {
      newestAt = stat.mtimeMs;
      newestPath = candidate;
    }
  }
  if (!newestPath) {
    const legacy = path.join(dir, 'transcript.json');
    assertWithinRoot(legacy, TRANSCRIPT_DRAFT_DIR);
    return legacy;
  }
  return newestPath;
}

function toSnapshotCandidate(raw: unknown): Record<string, unknown> {
  const input =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    segments: input.segments ?? [],
    translations: input.translations ?? {},
    // 正式稿/草稿历史格式使用 summaries；Socket canonical 格式使用 summaryBlocks。
    summaryBlocks: input.summaryBlocks ?? input.summaries ?? [],
    status: input.status ?? null,
    previewText: input.previewText,
    previewTranslation: input.previewTranslation,
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    translationMode: input.translationMode,
  };
}

async function loadCanonicalSnapshotFile(filePath: string): Promise<LiveSnapshot> {
  const raw = await readJsonFileBounded(
    filePath,
    MAX_LIVE_PERSISTED_JSON_BYTES
  );
  const parsed = canonicalizeLiveSnapshot(toSnapshotCandidate(raw));
  if (!parsed.ok) {
    throw new Error(`Persisted live snapshot is invalid: ${parsed.message}`);
  }
  if (parsed.bytes > MAX_LIVE_SNAPSHOT_BYTES) {
    throw new BoundedJsonFileError(
      'Persisted live snapshot exceeds the session byte budget',
      'FILE_TOO_LARGE'
    );
  }
  return parsed.value;
}

function logPersistedSnapshotFailure(
  sessionId: string,
  source: 'transcript' | 'draft',
  error: unknown
) {
  // 不存在是直播进行中的常态；只有已存在但超限/损坏/不合 schema 才记安全事件。
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
  liveShareLogger.warn(
    { sessionId, source, err: serializeError(error) },
    'Rejected persisted live snapshot during bounded recovery'
  );
}

async function loadPersistedSnapshot(sessionId: string): Promise<LiveSnapshot> {
  try {
    return await loadCanonicalSnapshotFile(readSessionTranscriptPath(sessionId));
  } catch (error) {
    logPersistedSnapshotFailure(sessionId, 'transcript', error);
  }

  // C16：data/transcripts/ 只有**收尾之后**才有文件；直播进行中转录稿在
  // data/transcript-drafts/。两条路径都先有界读取再走同一 strict schema，磁盘副本
  // 不能绕过 Socket 入站的 canonical/字节预算边界。
  try {
    return await loadCanonicalSnapshotFile(
      await resolveSessionTranscriptDraftPath(sessionId)
    );
  } catch (error) {
    logPersistedSnapshotFailure(sessionId, 'draft', error);
    return createEmptyLiveSnapshot();
  }
}

async function getSessionSnapshot(
  sessionId: string,
  ownerId: string,
  generationId: string
): Promise<LiveSnapshot> {
  if (!isActiveSnapshotGeneration(sessionId, generationId)) {
    throw new Error('Live snapshot generation has been superseded');
  }
  const inMemory = snapshots.get(sessionId);
  if (inMemory) {
    if (snapshots.getOwnerId(sessionId) !== ownerId) {
      throw new Error('Live snapshot owner does not match the session owner');
    }
    return inMemory;
  }

  const pending = snapshotLoadPromises.get(sessionId);
  if (pending?.generationId === generationId) {
    const snapshot = await pending.promise;
    if (!isActiveSnapshotGeneration(sessionId, generationId)) {
      throw new Error('Live snapshot generation has been superseded');
    }
    if (snapshots.getOwnerId(sessionId) !== ownerId) {
      throw new Error('Live snapshot owner does not match the session owner');
    }
    return snapshot;
  }

  const loadPromise = (async () => {
    const persisted = await loadPersistedSnapshot(sessionId);
    if (!isActiveSnapshotGeneration(sessionId, generationId)) {
      throw new Error('Live snapshot generation has been superseded');
    }
    // C16：读盘期间主播的首帧 sync_snapshot 可能已经落进内存。setIfAbsent
    // 保证首帧永远优先；singleflight 同时阻止大量观众在冷态重复读盘/JSON.parse。
    const admitted = snapshots.setIfAbsent(sessionId, ownerId, persisted);
    if (!admitted.ok) {
      liveShareLogger.warn(
        {
          sessionId,
          ownerId,
          code: admitted.code,
          bytes: admitted.bytes,
          limit: admitted.limit,
        },
        'Rejected live snapshot because an aggregate byte budget was exceeded'
      );
      throw new Error(admitted.message);
    }
    return admitted.value.snapshot;
  })();
  const entry: SnapshotLoadEntry = { generationId, promise: loadPromise };
  snapshotLoadPromises.set(sessionId, entry);
  const clearEntry = () => {
    if (snapshotLoadPromises.get(sessionId) === entry) {
      snapshotLoadPromises.delete(sessionId);
    }
  };
  void loadPromise.then(clearEntry, clearEntry);
  return loadPromise;
}

async function resolveViewerLink(shareToken: string) {
  const link = await prisma.shareLink.findUnique({
    where: { token: shareToken },
    include: {
      session: {
        select: {
          id: true,
          status: true,
          userId: true,
        },
      },
    },
  });

  if (!link || !link.isLive) {
    throw new Error('Invalid or expired share link');
  }

  if (link.expiresAt && link.expiresAt < new Date()) {
    throw new Error('Share link expired');
  }

  if (
    link.session.id !== link.sessionId ||
    link.createdBy !== link.session.userId
  ) {
    throw new Error('Invalid share link owner');
  }

  return link;
}

async function resolveBroadcasterShareLink(
  sessionId: string,
  shareToken: string,
  userId: string,
  expectedLinkId?: string
) {
  const shareLink = await prisma.shareLink.findUnique({
    where: { token: shareToken },
    include: {
      session: {
        select: {
          id: true,
          userId: true,
        },
      },
    },
  });

  if (
    !shareLink ||
    !shareLink.isLive ||
    (expectedLinkId !== undefined && shareLink.id !== expectedLinkId) ||
    shareLink.sessionId !== sessionId ||
    shareLink.session.id !== sessionId ||
    shareLink.createdBy !== userId ||
    shareLink.session.userId !== userId
  ) {
    throw new Error('Broadcaster is not authorized for this session');
  }

  if (shareLink.expiresAt && shareLink.expiresAt < new Date()) {
    throw new Error('Share link expired');
  }

  return shareLink;
}

async function authenticateBroadcaster(
  socket: Socket
): Promise<EstablishedBroadcasterContext> {
  const auth = (socket.handshake.auth ?? {}) as BroadcasterAuthPayload;
  if (!auth.sessionId || !auth.shareToken) {
    throw new Error('Missing broadcaster auth');
  }

  const jwtToken = resolveSocketJwt(socket, auth.token);
  if (!jwtToken) {
    throw new Error('Missing broadcaster auth');
  }

  const session = await verifyAuthToken(jwtToken);
  if (!session) {
    throw new Error('Broadcaster auth failed');
  }

  const sessionId = sanitizePath(auth.sessionId);
  const shareToken = sanitizeToken(auth.shareToken);
  const shareLink = await resolveBroadcasterShareLink(
    sessionId,
    shareToken,
    session.user.id
  );

  socket.data.isHost = true;
  socket.data.sessionId = sessionId;
  socket.data.userId = session.user.id;
  socket.join(getRoomId(sessionId));
  const snapshotGeneration = activateSnapshotGeneration(
    sessionId,
    shareLink.id
  );

  return {
    rawJwt: jwtToken,
    sessionId,
    userId: session.user.id,
    shareToken,
    shareLinkId: shareLink.id,
    snapshotGenerationId: snapshotGeneration.generationId,
    snapshotGenerationChanged: snapshotGeneration.changed,
  };
}

async function validateEstablishedBroadcaster(
  context: EstablishedBroadcasterContext
): Promise<void> {
  const diagnosis = await diagnoseEstablishedAuthFamilyToken(context.rawJwt);
  if (
    diagnosis.status === 'revoked' ||
    (diagnosis.status === 'valid' &&
      diagnosis.session.user.id !== context.userId)
  ) {
    throw new Error('Broadcaster authentication has been revoked');
  }

  await resolveBroadcasterShareLink(
    context.sessionId,
    context.shareToken,
    context.userId,
    context.shareLinkId
  );
  if (
    !isActiveSnapshotGeneration(
      context.sessionId,
      context.snapshotGenerationId
    )
  ) {
    throw new Error('Broadcaster share generation has been superseded');
  }
  // leaf_expired 不授予继续广播的权限；只有用户/family/link/generation 全部仍有效后，
  // 才用专用错误要求客户端携当前 Cookie 重新走一次 strict current-leaf 握手。
  if (diagnosis.status === 'leaf_expired') {
    throw new BroadcasterAuthLeafExpiredError();
  }
}

async function emitViewerCount(io: SocketIO, sessionId: string) {
  const roomSockets = await io.in(getRoomId(sessionId)).fetchSockets();
  const viewerCount = roomSockets.filter((roomSocket) => !roomSocket.data.isHost).length;
  io.to(getRoomId(sessionId)).emit('viewer_count', { count: viewerCount });
}

function createShareErrorHandler(socket: Socket) {
  return (message: string, code?: string) => {
    socket.emit('share_error', code ? { message, code } : { message });
  };
}

type EmitShareError = ReturnType<typeof createShareErrorHandler>;

function emitSnapshotPolicyError(
  socket: Socket,
  emitError: EmitShareError,
  code: LiveSnapshotPolicyErrorCode,
  detail: string,
  bytes?: number,
  limit?: number
) {
  liveShareLogger.warn(
    {
      socketId: socket.id,
      sessionId: socket.data.sessionId,
      code,
      detail,
      bytes,
      limit,
    },
    'Rejected live share state at the canonical snapshot boundary'
  );
  emitError('Live share payload rejected', code);
}

// SHARE-REVOKE-001：观众 token 只在 join 时校验一次，撤销/轮换/过期对已连接
// socket 原本永久无效。复核间隔是"错过撤销通知（WS 重启、内部请求失败）或链接
// 自然过期"时被驱逐的最坏延迟；撤销主路径走内部通知即时生效，不依赖这个间隔。
const LIVE_AUTH_REVALIDATE_INTERVAL_MS = 60_000;

const ROOM_PREFIX = 'live:';

interface RevalidateViewersOptions {
  /**
   * transition（录制结束转回放）场景静默断开：观众已被主播的 SHARE_OFFLINE 置为
   * 静态完成态，不发 share_error，避免完成视图被错误页覆盖。撤销/过期则要发，
   * 让观众明确看到"链接已失效"。两种断开客户端都不会自动重连
   * （reason = 'io server disconnect'）；就算手动重连，join 也会被重新校验拒绝。
   */
  silent?: boolean;
}

/**
 * 按 DB 当前状态重新校验某 session 房间里的所有观众，驱逐持失效 token 的 socket。
 * fail-safe：判定依据只有 DB（isLive + expiresAt + token 归属本 session），与触发
 * 来源无关——被恶意/重复触发时，合法观众重新校验后原样保留。返回驱逐数。
 */
export async function revalidateSessionViewers(
  io: SocketIO,
  sessionId: string,
  options: RevalidateViewersOptions = {}
): Promise<number> {
  const roomSockets = await io.in(getRoomId(sessionId)).fetchSockets();
  const viewers = roomSockets.filter((roomSocket) => !roomSocket.data.isHost);
  if (viewers.length === 0) {
    return 0;
  }

  const tokens = [
    ...new Set(
      viewers
        .map((viewer) =>
          typeof viewer.data.shareToken === 'string' ? viewer.data.shareToken : null
        )
        .filter((token): token is string => Boolean(token))
    ),
  ];

  const validLinks = tokens.length
    ? await prisma.shareLink.findMany({
        where: {
          token: { in: tokens },
          sessionId,
          isLive: true,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { token: true },
      })
    : [];
  const validTokens = new Set(validLinks.map((link) => link.token));

  let evicted = 0;
  for (const viewer of viewers) {
    const token = viewer.data.shareToken;
    if (typeof token === 'string' && validTokens.has(token)) {
      continue;
    }

    if (!options.silent) {
      viewer.emit('share_error', {
        message: 'Share link revoked',
        code: 'SHARE_REVOKED',
      });
    }
    viewer.disconnect(true);
    evicted += 1;
  }

  if (evicted > 0) {
    liveShareLogger.info(
      { sessionId, evicted, silent: Boolean(options.silent) },
      'Evicted live share viewers with revoked or expired tokens'
    );
    await emitViewerCount(io, sessionId).catch(() => undefined);
  }

  return evicted;
}

/**
 * 复核握手时已经严格认证成功的主持人。routine refresh 后旧 leaf 可由 established
 * 校验继续使用；family 撤销/过期、用户封禁/版本变化、DB 故障或分享链接换代则断连。
 */
export async function revalidateSessionBroadcasters(
  io: SocketIO,
  sessionId: string,
  options: { silent?: boolean } = {}
): Promise<number> {
  const sessionBroadcasters = activeBroadcastersByServer.get(io)?.get(sessionId);
  if (!sessionBroadcasters || sessionBroadcasters.size === 0) return 0;

  let revoked = 0;
  // revalidate 失败会同步触发 disconnect 并修改 registry，故先复制闭包快照再串行执行。
  for (const broadcaster of [...sessionBroadcasters.values()]) {
    if (!(await broadcaster.revalidate(options))) revoked += 1;
  }
  return revoked;
}

/** 对所有 live 房间跑一遍观众复核（周期兜底用），串行避免 DB 并发尖峰。 */
export async function revalidateAllLiveRooms(io: SocketIO): Promise<void> {
  const sessionIds: string[] = [];
  for (const room of io.sockets.adapter.rooms.keys()) {
    if (room.startsWith(ROOM_PREFIX)) {
      sessionIds.push(room.slice(ROOM_PREFIX.length));
    }
  }

  for (const sessionId of sessionIds) {
    try {
      await revalidateSessionViewers(io, sessionId);
    } catch (error) {
      liveShareLogger.warn(
        { sessionId, err: serializeError(error) },
        'Periodic live share viewer revalidation failed'
      );
    }
    try {
      await revalidateSessionBroadcasters(io, sessionId);
    } catch (error) {
      liveShareLogger.warn(
        { sessionId, err: serializeError(error) },
        'Periodic live share broadcaster revalidation failed'
      );
    }
  }
}

/**
 * 观众拿着另一个仍合法的同 session 链接加入，不代表主持人世代已经换代。先按 DB 复核
 * 当前房间；只在旧世代已经没有任何合法连接时才 CAS 退役它并激活新 link。这样并存的
 * 合法观看链接不会误踢主持人，而 A 已撤权且通知丢失时，B 仍会清空 A 快照后接管。
 */
async function selectViewerSnapshotGeneration(
  io: SocketIO,
  sessionId: string,
  linkId: string
): Promise<{ generationId: string; changed: boolean }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = snapshotGenerations.getActive(sessionId);
    if (!current || current.linkId === linkId) {
      return activateSnapshotGeneration(sessionId, linkId);
    }

    await revalidateSessionViewers(io, sessionId);
    await revalidateSessionBroadcasters(io, sessionId);

    const afterRevalidation = snapshotGenerations.getActive(sessionId);
    if (!afterRevalidation) {
      return activateSnapshotGeneration(sessionId, linkId);
    }
    if (afterRevalidation.generationId !== current.generationId) {
      continue;
    }

    const roomSockets = await io.in(getRoomId(sessionId)).fetchSockets();
    if (roomSockets.length > 0) {
      return {
        generationId: afterRevalidation.generationId,
        changed: false,
      };
    }

    if (
      invalidateSnapshotGeneration(sessionId, afterRevalidation.generationId)
    ) {
      return activateSnapshotGeneration(sessionId, linkId);
    }
  }

  throw new Error('Live share generation changed too many times');
}

// sync_snapshot / broadcast 的处理体。抽成模块级函数，是为了让 C16 的监听器能在
// 鉴权 await 之前同步注册（见 setupLiveShare 里的注释），逻辑本身与此前逐字一致。
function handleSyncSnapshot(
  socket: Socket,
  emitError: EmitShareError,
  payload: unknown,
  generationId?: string
) {
  if (!socket.data.isHost) {
    emitError('Only the broadcaster may sync snapshots');
    return;
  }

  const sessionId = socket.data.sessionId as string;
  const ownerId = socket.data.userId as string;
  if (
    !generationId ||
    !isActiveSnapshotGeneration(sessionId, generationId)
  ) {
    emitError('Broadcaster share generation has been superseded');
    return;
  }
  const parsed = canonicalizeLiveSnapshot(payload);
  if (!parsed.ok) {
    emitSnapshotPolicyError(
      socket,
      emitError,
      parsed.code,
      parsed.message,
      parsed.bytes,
      parsed.limit
    );
    return;
  }
  const admitted = snapshots.set(sessionId, ownerId, parsed.value);
  if (!admitted.ok) {
    emitSnapshotPolicyError(
      socket,
      emitError,
      admitted.code,
      admitted.message,
      admitted.bytes,
      admitted.limit
    );
  }
}

async function handleBroadcast(
  socket: Socket,
  emitError: EmitShareError,
  event: unknown,
  generationId?: string
) {
  if (!socket.data.isHost) {
    emitError('Only the broadcaster may publish events');
    return;
  }

  const sessionId = socket.data.sessionId as string;
  const ownerId = socket.data.userId as string;
  if (
    !generationId ||
    !isActiveSnapshotGeneration(sessionId, generationId)
  ) {
    emitError('Broadcaster share generation has been superseded');
    return;
  }
  await getSessionSnapshot(sessionId, ownerId, generationId);
  if (!isActiveSnapshotGeneration(sessionId, generationId)) return;
  const applied = snapshots.applyEvent(sessionId, ownerId, event);
  if (!applied.ok) {
    emitSnapshotPolicyError(
      socket,
      emitError,
      applied.code,
      applied.message,
      applied.bytes,
      applied.limit
    );
    return;
  }

  liveShareLogger.debug(
    {
      socketId: socket.id,
      sessionId,
      eventType: applied.value.event.type,
      snapshotBytes: applied.bytes,
    },
    'Broadcasted live share event'
  );

  // 只广播 canonical 副本；原始 payload 的未知/嵌套字段永远不会到达观众。
  socket
    .to(getRoomId(sessionId))
    .emit(applied.value.event.type, applied.value.event.payload);
}

/**
 * 装载实时分享逻辑，返回一个 teardown 函数：清掉 U61 的 TTL 清扫定时器与所有
 * 未决的 host 下线宽限计时，并清空快照 Map。生产环境 setupLiveShare 仅调用一次，
 * teardown 主要用于测试隔离与优雅关停（避免模块级定时器 / 快照跨用例泄漏）。
 */
export function setupLiveShare(io: SocketIO): () => void {
  const broadcasterRegistry: BroadcasterRegistry = new Map();
  activeBroadcastersByServer.set(io, broadcasterRegistry);

  // U61：后台 TTL 清扫僵尸快照。unref 避免阻塞进程退出。
  const sweepTimer = setInterval(() => {
    void sweepStaleSnapshots(io).catch(() => undefined);
  }, SNAPSHOT_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  // SHARE-REVOKE-001 / SEC-022：周期复核所有房间的观众 token 与主持人身份/分享世代，
  // 兜底撤销通知丢失、账号状态变化、链接删除或自然过期；主路径仍由内部通知即时触发。
  const revalidateTimer = setInterval(() => {
    void revalidateAllLiveRooms(io).catch(() => undefined);
  }, LIVE_AUTH_REVALIDATE_INTERVAL_MS);
  revalidateTimer.unref?.();

  io.on('connection', async (socket) => {
    const emitError = createShareErrorHandler(socket);
    const viewerJoinState = {
      queue: Promise.resolve(),
      rate: createViewerJoinRateState(),
      initialStateBudget: createViewerInitialStateBudget(),
      currentToken: null as string | null,
      currentSessionId: null as string | null,
    };

    // C16：主播客户端在底层 'connect' 触发的同一刻就补发 sync_snapshot，而鉴权是异步的
    // （verifyAuthToken + 两次 DB 查询）。若把 socket.on 注册在 await 之后，这一帧会落在
    // 「零监听器」窗口被 socket.io 直接丢弃 —— 冷开分享的观众因此永远拿不到开分享前的
    // 全部转录/摘要。故：鉴权 promise 先起、监听器**同步**注册（本函数到此没有 await，
    // 不存在丢帧窗口），handler 内部再 await 同一个 promise，既不丢帧也不放行未鉴权 socket。
    const hasBroadcasterAuth = Boolean(
      (socket.handshake.auth as BroadcasterAuthPayload | undefined)?.token
    );
    const broadcasterAuth = hasBroadcasterAuth
      ? authenticateBroadcaster(socket)
      : null;
    let broadcasterHandshakeSettled = false;
    let authenticatedBroadcasterContext: EstablishedBroadcasterContext | null = null;
    // 下面 await 之前若先 reject 会触发 unhandledRejection；挂一个空 catch 占位，
    // 真正的失败处理仍在下面的 try/catch 里（同一个 promise 可被多次 await）。
    if (broadcasterAuth) {
      void broadcasterAuth.then(
        (context) => {
          authenticatedBroadcasterContext = context;
          broadcasterHandshakeSettled = true;
        },
        () => {
          broadcasterHandshakeSettled = true;
        }
      );
    }
    let broadcasterValidationPromise: Promise<void> | null = null;
    let broadcasterRevoked = false;
    const revalidateBroadcaster = async (
      options: { silent?: boolean } = {}
    ): Promise<boolean> => {
      if (!broadcasterAuth || broadcasterRevoked || !socket.connected) {
        return false;
      }

      let context: EstablishedBroadcasterContext;
      try {
        context = await broadcasterAuth;
      } catch {
        // 严格握手失败由下方主流程统一记录、报错和断连。
        return false;
      }

      if (!broadcasterValidationPromise) {
        const validation = validateEstablishedBroadcaster(context);
        broadcasterValidationPromise = validation;
        // 只合并并发中的复核，不缓存已完成的成功；下一敏感事件必须重新查权威状态。
        void validation.then(
          () => {
            if (broadcasterValidationPromise === validation) {
              broadcasterValidationPromise = null;
            }
          },
          () => {
            if (broadcasterValidationPromise === validation) {
              broadcasterValidationPromise = null;
            }
          }
        );
      }

      try {
        await broadcasterValidationPromise;
        return true;
      } catch (error) {
        if (!broadcasterRevoked) {
          broadcasterRevoked = true;
          const leafExpired = error instanceof BroadcasterAuthLeafExpiredError;
          const isolatedOldGeneration = invalidateSnapshotGeneration(
            context.sessionId,
            context.snapshotGenerationId
          );
          // 安全撤权不是网络瞬断：立即隔离旧世代并宣告下线，绝不能走 15 秒 grace。
          if (isolatedOldGeneration) {
            cancelPendingHostOffline(context.sessionId);
            io.to(getRoomId(context.sessionId)).emit('status_update', {
              status: 'SHARE_OFFLINE',
            });
          }
          liveShareLogger.warn(
            {
              socketId: socket.id,
              sessionId: context.sessionId,
              userId: context.userId,
              err: serializeError(error),
            },
            'Disconnected broadcaster after established authorization failed'
          );
          if (!options.silent) {
            emitError(
              leafExpired
                ? 'Broadcaster authentication leaf expired'
                : 'Broadcaster authorization revoked',
              leafExpired
                ? 'BROADCASTER_AUTH_LEAF_EXPIRED'
                : 'BROADCASTER_AUTH_REVOKED'
            );
          }
          socket.disconnect(true);
        }
        return false;
      }
    };

    socket.on('sync_snapshot', (payload: unknown) => {
      // connect 首帧可能在严格握手查询尚未完成时先到。该 strict 查询本身发生在事件
      // 之后且完整校验 current leaf + 用户 + 分享链接，直接复用它可保住 C16 首帧；
      // 握手已经结束后才到的每个事件仍必须走 established-family 权威复核。
      const queuedDuringStrictHandshake = Boolean(
        broadcasterAuth && !broadcasterHandshakeSettled
      );
      void (async () => {
        let generationId: string | undefined;
        if (broadcasterAuth) {
          if (!queuedDuringStrictHandshake && !(await revalidateBroadcaster())) {
            return;
          }
          const context = await broadcasterAuth;
          if (!socket.connected || broadcasterRevoked) return;
          generationId = context.snapshotGenerationId;
        }
        handleSyncSnapshot(socket, emitError, payload, generationId);
      })().catch((error) => {
        liveShareLogger.warn(
          { socketId: socket.id, err: serializeError(error) },
          'Failed to process live snapshot'
        );
        emitError('Failed to process live snapshot');
      });
    });

    socket.on('broadcast', (message: unknown) => {
      const queuedDuringStrictHandshake = Boolean(
        broadcasterAuth && !broadcasterHandshakeSettled
      );
      void (async () => {
        let generationId: string | undefined;
        if (broadcasterAuth) {
          if (!queuedDuringStrictHandshake && !(await revalidateBroadcaster())) {
            return;
          }
          const context = await broadcasterAuth;
          if (!socket.connected || broadcasterRevoked) return;
          generationId = context.snapshotGenerationId;
        }
        const event =
          message && typeof message === 'object' && !Array.isArray(message)
            ? (message as { event?: unknown }).event
            : undefined;
        await handleBroadcast(socket, emitError, event, generationId);
      })().catch((error) => {
        liveShareLogger.warn(
          { socketId: socket.id, err: serializeError(error) },
          'Failed to process live broadcast'
        );
        emitError('Failed to process live broadcast');
      });
    });

    if (hasBroadcasterAuth && broadcasterAuth) {
      try {
        const context = await broadcasterAuth;
        if (!socket.connected || broadcasterRevoked) return;
        const sessionId = context.sessionId;
        let sessionBroadcasters = broadcasterRegistry.get(sessionId);
        if (!sessionBroadcasters) {
          sessionBroadcasters = new Map();
          broadcasterRegistry.set(sessionId, sessionBroadcasters);
        }
        sessionBroadcasters.set(socket.id, {
          revalidate: revalidateBroadcaster,
        });
        if (context.snapshotGenerationChanged) {
          await revalidateSessionViewers(io, sessionId);
          await revalidateSessionBroadcasters(io, sessionId);
          if (!socket.connected || broadcasterRevoked) return;
        }
        liveShareLogger.info(
          {
            socketId: socket.id,
            sessionId,
            userId: socket.data.userId,
            role: 'broadcaster',
          },
          'Broadcaster authenticated'
        );
        // C3/U11：主播（重）连成功——取消可能正在等待的下线宣告，保留其内存快照，
        // 并向房间广播 SHARE_LIVE，让此前误判为"已结束"的观众恢复实时视图。
        cancelPendingHostOffline(sessionId);
        socket.to(getRoomId(sessionId)).emit('status_update', { status: 'SHARE_LIVE' });
        const snapshot = await getSessionSnapshot(
          sessionId,
          socket.data.userId as string,
          context.snapshotGenerationId
        );
        socket.emit('initial_state', snapshot);
        await emitViewerCount(io, sessionId);
      } catch (error) {
        liveShareLogger.warn(
          {
            socketId: socket.id,
            err: serializeError(error),
          },
          'Broadcaster authentication failed'
        );
        emitError(error instanceof Error ? error.message : 'Broadcaster auth failed');
        socket.disconnect();
        return;
      }
    }

    socket.on('join', (payload: unknown) => {
      // 同一 socket 的 join 严格串行。这样首个授权尚在 DB 查询时到达的 40 个重复
      // 事件会在首个成功后全部命中幂等早退，不会各自查询/发快照/扫描房间。
      viewerJoinState.queue = viewerJoinState.queue.then(async () => {
        try {
          if (hasBroadcasterAuth || socket.data.isHost) {
            emitError('Broadcaster sockets cannot join as viewers');
            return;
          }

          const parsedToken = parseViewerJoinToken(payload);
          if (
            parsedToken.ok &&
            viewerJoinState.currentToken === parsedToken.token &&
            viewerJoinState.currentSessionId === socket.data.sessionId
          ) {
            return;
          }

          // 无效 token 也消耗成本令牌，避免随机高基数 token 绕开 DB 前门禁。
          if (!consumeViewerJoinAttempt(viewerJoinState.rate)) {
            emitError('Too many live share join attempts', 'JOIN_RATE_LIMITED');
            return;
          }
          if (!parsedToken.ok) {
            emitError(parsedToken.message, parsedToken.code);
            return;
          }

          const safeToken = parsedToken.token;
          const link = await resolveViewerLink(safeToken);
          const sessionId = link.sessionId;
          const ownerId = link.session.userId;
          if (typeof ownerId !== 'string' || !ownerId) {
            throw new Error('Invalid share link owner');
          }

          const generation = await selectViewerSnapshotGeneration(
            io,
            sessionId,
            link.id
          );
          if (generation.changed) {
            await revalidateSessionViewers(io, sessionId);
            await revalidateSessionBroadcasters(io, sessionId);
            if (!socket.connected) return;
          }
          await getSessionSnapshot(
            sessionId,
            ownerId,
            generation.generationId
          );
          // await continuation 与 getSessionSnapshot 内最后一次检查之间仍可能被新世代插队；
          // emit 前重新取得当前对象，使 A 的迟到读盘结果永远不能发给 B token 的观众。
          if (!isActiveSnapshotGeneration(sessionId, generation.generationId)) {
            throw new Error('Live snapshot generation has been superseded');
          }
          const snapshot = snapshots.get(sessionId);
          const snapshotBytes = snapshots.getBytes(sessionId);
          if (!snapshot || snapshotBytes === undefined) {
            throw new Error('Live snapshot is unavailable');
          }
          const responseBytes = socketIoEventByteLength(
            'initial_state',
            snapshotBytes
          );
          if (!socket.connected) return;
          if (
            !reserveViewerInitialStateBytes(
              viewerJoinState.initialStateBudget,
              responseBytes,
              MAX_LIVE_INITIAL_STATE_BYTES_PER_SOCKET
            )
          ) {
            emitError(
              'Live share initial state response budget exceeded',
              'INITIAL_STATE_BUDGET_EXCEEDED'
            );
            return;
          }

          // 所有可能失败的授权/读取/预算检查都在房间变更之前完成。切换 B 失败时，
          // socket 仍留在 A，不会因为攻击性请求丢失原本合法的观看资格。
          const previousSessionId = viewerJoinState.currentSessionId;
          const membershipChanged = previousSessionId !== sessionId;
          if (previousSessionId && membershipChanged) {
            socket.leave(getRoomId(previousSessionId));
          }
          if (membershipChanged) {
            socket.join(getRoomId(sessionId));
          }

          socket.data.isHost = false;
          socket.data.sessionId = sessionId;
          // SHARE-REVOKE-001：记录观众所持 token，撤销/过期复核时按它重新校验。
          socket.data.shareToken = safeToken;
          viewerJoinState.currentToken = safeToken;
          viewerJoinState.currentSessionId = sessionId;
          socket.emit('initial_state', snapshot);

          liveShareLogger.info(
            {
              socketId: socket.id,
              sessionId,
              role: 'viewer',
              initialStateBytes: responseBytes,
              cumulativeInitialStateBytes:
                viewerJoinState.initialStateBudget.sentBytes,
            },
            'Viewer joined live share session'
          );

          // Socket.IO room membership 本身幂等；只有真实迁移才扫描/广播 count。
          if (membershipChanged) {
            if (previousSessionId) {
              await emitViewerCount(io, previousSessionId).catch(() => undefined);
            }
            await emitViewerCount(io, sessionId).catch(() => undefined);
          }
        } catch (error) {
          liveShareLogger.warn(
            {
              socketId: socket.id,
              err: serializeError(error),
            },
            'Viewer failed to join live share session'
          );
          emitError(
            error instanceof Error ? error.message : 'Failed to join live share'
          );
        }
      });
    });

    socket.on('disconnect', async () => {
      const sessionId = socket.data.sessionId as string | undefined;
      if (!sessionId) {
        return;
      }

      if (socket.data.isHost) {
        const sessionBroadcasters = broadcasterRegistry.get(sessionId);
        sessionBroadcasters?.delete(socket.id);
        if (sessionBroadcasters?.size === 0) {
          broadcasterRegistry.delete(sessionId);
        }
        // 安全撤权已经同步隔离旧世代并宣告下线，不允许重新进入网络断线 grace。
        if (!broadcasterRevoked) {
          // C3/U11：不立即宣告 SHARE_OFFLINE / 删除快照，先起宽限计时。若主播在窗口内
          // 于新 socket 上重连，authenticateBroadcaster 会 cancelPendingHostOffline 取消
          // 本计时并保留快照；只有窗口内未回来才广播下线并回收内存。计时器 unref，避免
          // 阻塞进程退出。回调内再次核验房间内确无主播 socket，防止极端时序下误报下线。
          cancelPendingHostOffline(sessionId);
          const expectedGeneration =
            authenticatedBroadcasterContext?.snapshotGenerationId;
          const timer = setTimeout(() => {
            pendingHostOffline.delete(sessionId);
            void (async () => {
              try {
                const roomSockets = await io.in(getRoomId(sessionId)).fetchSockets();
                const hostStillConnected = roomSockets.some((s) => s.data.isHost);
                if (hostStillConnected) {
                  return;
                }
              } catch {
                // fetchSockets 失败（如服务器正在关闭）——保守地跳过下线广播，
                // 快照由 U61 的 TTL 清扫兜底回收。
                return;
              }
              // fetchSockets 等待期间可能已有 B 世代接管；先 compare-and-invalidate，
              // 只有确实退役本 socket 的旧世代时才允许向房间宣告下线。
              if (
                !expectedGeneration ||
                !invalidateSnapshotGeneration(sessionId, expectedGeneration)
              ) {
                return;
              }
              io.to(getRoomId(sessionId)).emit('status_update', {
                status: 'SHARE_OFFLINE',
              });
            })();
          }, HOST_OFFLINE_GRACE_MS);
          timer.unref?.();
          pendingHostOffline.set(sessionId, timer);
        }
      }

      liveShareLogger.info(
        {
          socketId: socket.id,
          sessionId,
          role: socket.data.isHost ? 'broadcaster' : 'viewer',
        },
        'Live share socket disconnected'
      );

      await emitViewerCount(io, sessionId).catch(() => undefined);
    });
  });

  return function teardownLiveShare() {
    clearInterval(sweepTimer);
    clearInterval(revalidateTimer);
    for (const timer of pendingHostOffline.values()) {
      clearTimeout(timer);
    }
    pendingHostOffline.clear();
    broadcasterRegistry.clear();
    activeBroadcastersByServer.delete(io);
    snapshotLoadPromises.clear();
    snapshots.clear();
    snapshotGenerations.clear();
  };
}
