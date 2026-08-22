// src/lib/liveShare/server.ts
// 服务端 socket.io 实时分享逻辑

import { Server as SocketIO, Socket } from 'socket.io';
import { prisma } from '@/lib/prisma';
import { sanitizePath, sanitizeToken } from '@/lib/security';
import { loadSessionTranscriptBundle } from '@/lib/sessionPersistence';
import { logger, serializeError } from '@/lib/logger';
import {
  EMPTY_STREAMING_PREVIEW_TEXT,
  EMPTY_STREAMING_PREVIEW_TRANSLATION,
  normalizePreviewText,
  normalizePreviewTranslation,
} from '@/lib/transcriptPreview';
import {
  CLIENT_SESSION_TOKEN,
  extractTokenFromCookieHeader,
  verifyAuthToken,
} from '@/lib/auth';
import { loadTranscriptDraft } from '@/lib/transcriptDraftPersistence';
import {
  MAX_PERSISTED_SNAPSHOT_BYTES,
  readSnapshotChunkMeta,
  trimSnapshotToByteBudget,
} from './snapshotChunking';
import type {
  StreamingPreviewText,
  StreamingPreviewTranslation,
} from '@/types/transcript';

const liveShareLogger = logger.child({ component: 'live-share' });

interface BroadcasterAuthPayload {
  token?: string;
  sessionId?: string;
  shareToken?: string;
}

interface LiveEventPayload {
  type: 'transcript_delta' | 'translation_delta' | 'summary_update' | 'status_update' | 'preview_update';
  payload: unknown;
  timestamp: number;
}

interface LiveSnapshot {
  segments: unknown[];
  translations: Record<string, string>;
  summaryBlocks: unknown[];
  status: string | null;
  /** 当前正在说的流式预览文本（临时，不持久化） */
  previewText: StreamingPreviewText;
  previewTranslation: StreamingPreviewTranslation;
  /** 翻译元数据 */
  sourceLang: string | null;
  targetLang: string | null;
  translationMode: string | null;
  /**
   * H1/L3：本快照不是完整历史 —— 主播端因传输体积上限丢掉了最早的一段 backlog，
   * 或服务端从磁盘草稿恢复时按字节预算裁掉了最早的一段。随 initial_state 下发给
   * 观众，让观众端能明确提示「历史不全」，而不是把残缺当完整。
   */
  truncated: boolean;
  updatedAt: number;
}

interface ViewerJoinPayload {
  shareToken?: string;
}

/**
 * H1：分块 sync_snapshot 的暂存态，挂在**主播 socket** 的 socket.data 上。
 * 挂在 socket 上而非模块级 Map，是因为它天然随 socket 生命周期回收：主播断连时
 * 未完成的批次自动作废，不需要额外清扫（也就不会出现 U61 那种僵尸条目）。
 * 只有集齐 expectedChunks 块才写进 snapshots —— 观众永远读不到半份快照。
 */
interface SnapshotStaging {
  chunkId: string;
  expectedChunks: number;
  receivedChunks: number;
  snapshot: LiveSnapshot;
}

const snapshots = new Map<string, LiveSnapshot>();

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
  for (const [sessionId, snapshot] of snapshots) {
    if (now - snapshot.updatedAt < SNAPSHOT_TTL_MS) {
      continue;
    }
    // 房间内仍有 socket（观众/主播）则保留；仅回收确无成员的僵尸条目。
    let roomEmpty = false;
    try {
      const roomSockets = await io.in(getRoomId(sessionId)).fetchSockets();
      roomEmpty = roomSockets.length === 0;
    } catch {
      continue;
    }
    if (roomEmpty && !pendingHostOffline.has(sessionId)) {
      snapshots.delete(sessionId);
      liveShareLogger.info(
        { sessionId, ageMs: now - snapshot.updatedAt },
        'Reclaimed stale live snapshot with no active room members'
      );
    }
  }
}

// sync_snapshot / broadcast 快照体量上限：防止主播端（已认证，但可能因 bug 或滥用）
// 推超大 snapshot 长期驻留服务端内存。maxHttpBufferSize(100KB) 已是消息体硬上限，
// 这里是防御纵深 + 类型校验——超限截断（而非拒连），正常课堂远达不到此量级。
const MAX_SNAPSHOT_SEGMENTS = 10_000;
const MAX_SNAPSHOT_SUMMARY_BLOCKS = 10_000;
const MAX_SNAPSHOT_TRANSLATIONS = 10_000;
const MAX_TRANSLATION_LENGTH = 10_000;

// 截断超量数组，保护服务端内存（非数组归一为空数组）
function clampArray(input: unknown, max: number): unknown[] {
  if (!Array.isArray(input)) return [];
  return input.length > max ? input.slice(0, max) : input;
}

// 单条字符串长度封顶（仅截长度，类型不符时原样返回，由上层处理）
function clampString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.length > MAX_TRANSLATION_LENGTH
    ? value.slice(0, MAX_TRANSLATION_LENGTH)
    : value;
}

// 原地截断 transcript segment 的文本字段长度，防止单条 segment.text 撑爆内存。
// 数组条数已由 clampArray / MAX_SNAPSHOT_SEGMENTS 另行限制，这里只管单条长度。
function sanitizeSegment(segment: unknown): unknown {
  if (!segment || typeof segment !== 'object') return segment;
  const seg = segment as { text?: unknown; translatedText?: unknown };
  if (typeof seg.text === 'string') {
    seg.text = clampString(seg.text);
  }
  if (typeof seg.translatedText === 'string') {
    seg.translatedText = clampString(seg.translatedText);
  }
  return segment;
}

// 原地截断 summary block 内各字符串字段长度（summary / keyPoints[*] /
// definitions 各 value / suggestedQuestions[*]），防止单条快照撑爆内存。
// 数组/对象条数由 MAX_SNAPSHOT_SUMMARY_BLOCKS 等另行限制，这里只管单条长度。
function sanitizeSummaryBlock(block: unknown): unknown {
  if (!block || typeof block !== 'object') return block;
  const b = block as {
    summary?: unknown;
    keyPoints?: unknown;
    definitions?: unknown;
    suggestedQuestions?: unknown;
  };

  if (typeof b.summary === 'string') {
    b.summary = clampString(b.summary);
  }

  if (Array.isArray(b.keyPoints)) {
    for (let i = 0; i < b.keyPoints.length; i += 1) {
      b.keyPoints[i] = clampString(b.keyPoints[i]);
    }
  }

  if (Array.isArray(b.suggestedQuestions)) {
    for (let i = 0; i < b.suggestedQuestions.length; i += 1) {
      b.suggestedQuestions[i] = clampString(b.suggestedQuestions[i]);
    }
  }

  if (b.definitions && typeof b.definitions === 'object') {
    const defs = b.definitions as Record<string, unknown>;
    for (const key of Object.keys(defs)) {
      defs[key] = clampString(defs[key]);
    }
  }

  return block;
}

// 清洗 sync_snapshot 的 translations：仅接受 string 值，单条长度封顶 + 条目数封顶
function sanitizeSnapshotTranslations(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (count >= MAX_SNAPSHOT_TRANSLATIONS) break;
    if (typeof value !== 'string') continue;
    out[key] =
      value.length > MAX_TRANSLATION_LENGTH
        ? value.slice(0, MAX_TRANSLATION_LENGTH)
        : value;
    count += 1;
  }
  return out;
}

// L5：未鉴权的 join 会打一次匿名 prisma.shareLink.findUnique。全局令牌桶
// （server/websocket.ts：20 msg/s）叠上每 IP 50 条连接，理论放大到 ~1000 q/s 的
// 匿名 DB 查询。合法客户端每条连接只 join 一次（重连后再一次），因此这里再加一层
// **每 socket** 的 join 预算即可把放大砍掉一个量级，且完全不触碰 SHARE-REVOKE-001
// 的判定口径（不缓存查询结果 —— 缓存会让已撤销的 token 在 TTL 内继续 join 成功）。
const JOIN_BUCKET_CAPACITY = 5;
const JOIN_REFILL_PER_SEC = 1;

interface JoinRateState {
  tokens: number;
  lastRefillMs: number;
}

function consumeJoinToken(socket: Socket): boolean {
  const now = Date.now();
  const state = (socket.data.joinRate as JoinRateState | undefined) ?? {
    tokens: JOIN_BUCKET_CAPACITY,
    lastRefillMs: now,
  };
  const elapsedMs = now - state.lastRefillMs;
  if (elapsedMs > 0) {
    state.tokens = Math.min(
      JOIN_BUCKET_CAPACITY,
      state.tokens + (elapsedMs / 1000) * JOIN_REFILL_PER_SEC
    );
    state.lastRefillMs = now;
  }
  socket.data.joinRate = state;

  if (state.tokens < 1) {
    return false;
  }
  state.tokens -= 1;
  return true;
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

function buildEmptySnapshot(): LiveSnapshot {
  return {
    segments: [],
    translations: {},
    summaryBlocks: [],
    status: null,
    previewText: EMPTY_STREAMING_PREVIEW_TEXT,
    previewTranslation: EMPTY_STREAMING_PREVIEW_TRANSLATION,
    sourceLang: null,
    targetLang: null,
    translationMode: null,
    truncated: false,
    updatedAt: Date.now(),
  };
}

/**
 * 读取**已收尾**会话的转录产物。以 DB 的 `Session.transcriptPath` 为准，不再按
 * 约定拼 `data/transcripts/{id}.json`。
 *
 * 为什么必须改：产物落盘早已改成版本化文件名
 * （`sessionPersistence.ts` 的 `buildVersionedArtifactFileName` → `{id}-{stamp}.json`），
 * 先是 `api/sessions/[id]/transcript` 走了 staged 写入，随后 M5 把 finalize 主链路
 * 也切了过去。约定式路径于是对**所有新收尾的会话必然 ENOENT**，然后静默掉进
 * catch → 回退读草稿 → 而草稿在收尾时已被删 → 最终给观众推一份空快照。
 * 整条链全被 catch 吞掉，无任何日志。
 * 顺带解决另一个老问题：配了 Cloudreve 时产物根本不在本地，约定式路径只能碰运气；
 * `loadSessionTranscriptBundle` 走 `readArtifactFromReference`，local / cloudreve 两种
 * 存储都覆盖，并且在引用读不出来时仍会回退试一次 legacy 的 `{id}.json`（老会话不丢）。
 */
async function loadFinalizedTranscriptBundle(sessionId: string) {
  let session: {
    id: string;
    userId: string;
    recordingPath: string | null;
    transcriptPath: string | null;
    summaryPath: string | null;
  } | null = null;

  try {
    session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        recordingPath: true,
        transcriptPath: true,
        summaryPath: true,
      },
    });
  } catch (error) {
    liveShareLogger.warn(
      { sessionId, err: serializeError(error) },
      'Failed to look up session transcript path for live snapshot'
    );
    return null;
  }

  if (!session) {
    return null;
  }

  try {
    const bundle = await loadSessionTranscriptBundle(session);
    if (!bundle && session.transcriptPath) {
      // 真异常：DB 登记了产物却读不出来（文件被删 / Cloudreve 不可达 / JSON 损坏）。
      // 与「冷开分享本来就还没有产物」（transcriptPath 为空）区分开，别一起静默。
      liveShareLogger.warn(
        { sessionId, transcriptPath: session.transcriptPath },
        'Session has a transcript artifact reference but it could not be loaded for the live snapshot'
      );
    }
    return bundle;
  } catch (error) {
    liveShareLogger.warn(
      { sessionId, transcriptPath: session.transcriptPath, err: serializeError(error) },
      'Failed to load session transcript artifact for the live snapshot'
    );
    return null;
  }
}

/**
 * L3：从磁盘（收尾产物 / 转录草稿）恢复的快照此前**绕过全部 clamp** 直接进内存并
 * 原样作为 initial_state 推给每个 join 的观众。草稿 PUT 侧既无限流也无 segment 体积
 * 校验（transcriptDraftPersistence.ts 自认），异常巨大的草稿会让服务端常驻 MB 级
 * 快照、每个观众 join 都拉一遍。这里补齐两道闸，与 sync_snapshot 入口同口径：
 *   ① 条数/单条长度：复用 MAX_SNAPSHOT_* 与 sanitize*（U24 那套）；
 *   ② 总字节：按 MAX_PERSISTED_SNAPSHOT_BYTES 保留最近的、裁掉最早的，并置
 *      truncated 让观众端知道 backlog 不全。
 */
function buildSnapshotFrom(parsed: {
  segments?: unknown[];
  translations?: Record<string, string>;
  summaries?: unknown[];
  status?: string;
}): LiveSnapshot {
  const clamped = {
    segments: clampArray(parsed.segments, MAX_SNAPSHOT_SEGMENTS).map(
      sanitizeSegment
    ),
    summaryBlocks: clampArray(parsed.summaries, MAX_SNAPSHOT_SUMMARY_BLOCKS).map(
      sanitizeSummaryBlock
    ),
    translations: sanitizeSnapshotTranslations(parsed.translations),
  };

  const trimmed = trimSnapshotToByteBudget(clamped, MAX_PERSISTED_SNAPSHOT_BYTES);
  if (trimmed.truncated) {
    liveShareLogger.warn(
      {
        droppedSegments: trimmed.droppedSegments,
        droppedSummaryBlocks: trimmed.droppedSummaryBlocks,
        budgetBytes: MAX_PERSISTED_SNAPSHOT_BYTES,
      },
      'Persisted live snapshot exceeded the outbound byte budget; trimmed to the most recent content'
    );
  }

  return {
    segments: trimmed.segments,
    translations: trimmed.translations,
    summaryBlocks: trimmed.summaryBlocks,
    status: typeof parsed.status === 'string' ? parsed.status : null,
    previewText: EMPTY_STREAMING_PREVIEW_TEXT,
    previewTranslation: EMPTY_STREAMING_PREVIEW_TRANSLATION,
    sourceLang: null,
    targetLang: null,
    translationMode: null,
    truncated: trimmed.truncated,
    updatedAt: Date.now(),
  };
}

/**
 * 观众 join 时服务端内存无快照的回填链，三级：
 *   ① 已收尾会话的转录产物（按 DB 的 transcriptPath，见 loadFinalizedTranscriptBundle）；
 *   ② C16：直播进行中的转录草稿 —— 收尾产物只有**收尾之后**才有，冷开分享
 *      （先录一段再点分享）时必然还不存在，只读 ① 就等于观众永远拿不到开分享前的内容；
 *   ③ 空快照。
 * 两级都要过 buildSnapshotFrom 的 clamp（L3），任何一级都不得绕开体积闸。
 */
async function loadPersistedSnapshot(sessionId: string): Promise<LiveSnapshot> {
  const bundle = await loadFinalizedTranscriptBundle(sessionId);
  if (bundle) {
    return buildSnapshotFrom({
      segments: bundle.segments,
      translations: bundle.translations,
      summaries: bundle.summaries,
    });
  }

  try {
    const draft = await loadTranscriptDraft({ id: sessionId, userId: '' });
    if (draft) {
      return buildSnapshotFrom({
        segments: draft.segments,
        translations: draft.translations,
        summaries: draft.summaries,
      });
    }
  } catch (error) {
    // 草稿不可读也不算错（直播尚未产生草稿是常态）：记一条 debug 后回退空快照
    liveShareLogger.debug(
      { sessionId, err: serializeError(error) },
      'Live share transcript draft was unreadable; falling back to an empty snapshot'
    );
  }

  return buildEmptySnapshot();
}

async function getSessionSnapshot(sessionId: string): Promise<LiveSnapshot> {
  const inMemory = snapshots.get(sessionId);
  if (inMemory) {
    return inMemory;
  }

  const persisted = await loadPersistedSnapshot(sessionId);
  // C16：读盘期间主播的首帧 sync_snapshot 可能已经落进内存（鉴权刚完成、initial_state
  // 还在读盘的窗口正好重叠）。这里若无条件 set，就把刚到的全量快照抹回空盘态——
  // 冷开分享的首帧正是这样丢的。重查一次，已有则以内存为准。
  const current = snapshots.get(sessionId);
  if (current) {
    return current;
  }
  snapshots.set(sessionId, persisted);
  return persisted;
}

function mergeTranscriptSegment(snapshot: LiveSnapshot, segment: unknown) {
  if (!segment || typeof segment !== 'object') {
    return snapshot;
  }

  sanitizeSegment(segment);

  const maybeSegment = segment as { id?: string };
  if (!maybeSegment.id) {
    // 无 id 段落只能追加，无法去重——达到条数上限后拒绝新增，防止 broadcast
    // 增量路径绕过 sync_snapshot 的 MAX_SNAPSHOT_SEGMENTS（U24）。
    if (snapshot.segments.length < MAX_SNAPSHOT_SEGMENTS) {
      snapshot.segments.push(segment);
    }
    return snapshot;
  }

  const index = snapshot.segments.findIndex((item) => {
    if (!item || typeof item !== 'object') return false;
    return (item as { id?: string }).id === maybeSegment.id;
  });

  if (index === -1) {
    // 新 id：仅在未达上限时追加（已存在的 id 走原地替换，不增长，故不受限）。
    if (snapshot.segments.length < MAX_SNAPSHOT_SEGMENTS) {
      snapshot.segments.push(segment);
    }
  } else {
    snapshot.segments[index] = segment;
  }

  return snapshot;
}

function mergeSummaryBlock(snapshot: LiveSnapshot, block: unknown) {
  if (!block || typeof block !== 'object') {
    return snapshot;
  }

  sanitizeSummaryBlock(block);

  const maybeBlock = block as { id?: string; blockIndex?: number };
  const index = snapshot.summaryBlocks.findIndex((item) => {
    if (!item || typeof item !== 'object') return false;
    const existing = item as { id?: string; blockIndex?: number };
    if (maybeBlock.id && existing.id) {
      return existing.id === maybeBlock.id;
    }
    if (typeof maybeBlock.blockIndex === 'number' && typeof existing.blockIndex === 'number') {
      return existing.blockIndex === maybeBlock.blockIndex;
    }
    return false;
  });

  if (index === -1) {
    // 新增 summary block：仅在未达上限时追加，防止 broadcast 增量路径绕过
    // MAX_SNAPSHOT_SUMMARY_BLOCKS（U24）。已存在的走原地替换，不增长。
    if (snapshot.summaryBlocks.length < MAX_SNAPSHOT_SUMMARY_BLOCKS) {
      snapshot.summaryBlocks.push(block);
    }
  } else {
    snapshot.summaryBlocks[index] = block;
  }

  return snapshot;
}

function mergeEventIntoSnapshot(
  snapshot: LiveSnapshot,
  event: LiveEventPayload
): LiveSnapshot {
  switch (event.type) {
    case 'transcript_delta':
      mergeTranscriptSegment(snapshot, event.payload);
      break;
    case 'translation_delta': {
      if (
        event.payload &&
        typeof event.payload === 'object' &&
        typeof (event.payload as { segmentId?: string }).segmentId === 'string' &&
        typeof (event.payload as { translation?: string }).translation === 'string'
      ) {
        const payload = event.payload as {
          segmentId: string;
          translation: string;
          sourceLang?: string;
          targetLang?: string;
          translationMode?: string;
        };
        // 新 segmentId 达到条目上限时拒绝新增，防止 broadcast 增量路径绕过
        // MAX_SNAPSHOT_TRANSLATIONS（U24）。已存在的 key 走覆盖，不增长。
        const isNewTranslationKey = !Object.prototype.hasOwnProperty.call(
          snapshot.translations,
          payload.segmentId
        );
        if (
          !isNewTranslationKey ||
          Object.keys(snapshot.translations).length < MAX_SNAPSHOT_TRANSLATIONS
        ) {
          snapshot.translations[payload.segmentId] =
            payload.translation.length > MAX_TRANSLATION_LENGTH
              ? payload.translation.slice(0, MAX_TRANSLATION_LENGTH)
              : payload.translation;
        }
        // 更新翻译元数据（如果 delta 中携带）
        if (typeof payload.sourceLang === 'string') snapshot.sourceLang = payload.sourceLang;
        if (typeof payload.targetLang === 'string') snapshot.targetLang = payload.targetLang;
        if (typeof payload.translationMode === 'string') snapshot.translationMode = payload.translationMode;
      }
      break;
    }
    case 'summary_update':
      mergeSummaryBlock(snapshot, event.payload);
      break;
    case 'status_update': {
      if (
        event.payload &&
        typeof event.payload === 'object' &&
        typeof (event.payload as { status?: string }).status === 'string'
      ) {
        snapshot.status = (event.payload as { status: string }).status;
      }
      break;
    }
    case 'preview_update': {
      if (event.payload && typeof event.payload === 'object') {
        const p = event.payload as {
          previewText?: StreamingPreviewText | string;
          previewTranslation?: StreamingPreviewTranslation | string;
        };
        snapshot.previewText = p.previewText
          ? normalizePreviewText(p.previewText)
          : EMPTY_STREAMING_PREVIEW_TEXT;
        snapshot.previewTranslation = p.previewTranslation
          ? normalizePreviewTranslation(p.previewTranslation)
          : EMPTY_STREAMING_PREVIEW_TRANSLATION;
      }
      break;
    }
  }

  snapshot.updatedAt = Date.now();
  return snapshot;
}

async function resolveViewerLink(shareToken: string) {
  const link = await prisma.shareLink.findUnique({
    where: { token: shareToken },
    include: {
      session: {
        select: {
          id: true,
          status: true,
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

  return link;
}

async function authenticateBroadcaster(socket: Socket) {
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
    shareLink.sessionId !== sessionId ||
    shareLink.createdBy !== session.user.id ||
    shareLink.session.userId !== session.user.id
  ) {
    throw new Error('Broadcaster is not authorized for this session');
  }

  if (shareLink.expiresAt && shareLink.expiresAt < new Date()) {
    throw new Error('Share link expired');
  }

  socket.data.isHost = true;
  socket.data.sessionId = sessionId;
  socket.data.userId = session.user.id;
  socket.join(getRoomId(sessionId));

  return { sessionId };
}

async function emitViewerCount(io: SocketIO, sessionId: string) {
  const roomSockets = await io.in(getRoomId(sessionId)).fetchSockets();
  const viewerCount = roomSockets.filter((roomSocket) => !roomSocket.data.isHost).length;
  io.to(getRoomId(sessionId)).emit('viewer_count', { count: viewerCount });
}

function createShareErrorHandler(socket: Socket) {
  return (message: string) => {
    socket.emit('share_error', { message });
  };
}

// SHARE-REVOKE-001：观众 token 只在 join 时校验一次，撤销/轮换/过期对已连接
// socket 原本永久无效。复核间隔是"错过撤销通知（WS 重启、内部请求失败）或链接
// 自然过期"时被驱逐的最坏延迟；撤销主路径走内部通知即时生效，不依赖这个间隔。
const VIEWER_REVALIDATE_INTERVAL_MS = 60_000;

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
  }
}

// sync_snapshot / broadcast 的处理体。抽成模块级函数，是为了让 C16 的监听器能在
// 鉴权 await 之前同步注册（见 setupLiveShare 里的注释）。
//
// H1：现在的 sync_snapshot 是**分块协议**（线协议与打包见 snapshotChunking.ts）：
//   - 无分块字段            → 旧式单块全量，行为与此前逐字一致（滚动发布/旧客户端）；
//   - chunkIndex === 0      → 新一批的首块，落进 socket 上的暂存位；
//   - 0 < chunkIndex        → 续块，按序追加进暂存快照；
//   - 收满 chunkCount 块    → 原子提交进 snapshots（全量覆盖语义在这一刻才生效）。
// 之所以要暂存而不是逐块直接覆盖/追加：sync_snapshot 是**全量覆盖**语义（U11），
// 用半份内容覆盖会把服务端已累积的历史整个抹掉，正是 U11 注释警告过的事故形态。
function handleSyncSnapshot(
  socket: Socket,
  emitError: (message: string) => void,
  payload: Partial<LiveSnapshot>
) {
  if (!socket.data.isHost) {
    emitError('Only the broadcaster may sync snapshots');
    return;
  }

  const sessionId = socket.data.sessionId as string;
  const chunkMeta = readSnapshotChunkMeta(payload);

  if (chunkMeta.kind === 'invalid') {
    // 带了分块字段却不合法：**只丢这一条**。两条理由：
    // ① 绝不降级成「全量覆盖」——把续块当全量就是用残片抹掉历史（U11 的事故形态）；
    // ② 也不清掉当前暂存——一条畸形消息不该把正在进行的合法批次一起毁掉。
    liveShareLogger.warn(
      { socketId: socket.id, sessionId },
      'Dropped sync_snapshot with malformed chunk metadata'
    );
    return;
  }

  if (chunkMeta.kind === 'chunk' && chunkMeta.meta.chunkIndex > 0) {
    const staging = socket.data.snapshotStaging as SnapshotStaging | undefined;

    // 不属于当前批次（首块从未到达，或上一批被新批次顶掉后的迟到残块）：只丢这一条。
    // 这里**不能**顺手清掉暂存——否则上一批的一条迟到续块就能把当前这一批毁掉，
    // 结果是两批都提交不了、服务端快照停留在更早的旧态。
    if (!staging || staging.chunkId !== chunkMeta.meta.chunkId) {
      liveShareLogger.warn(
        {
          socketId: socket.id,
          sessionId,
          chunkIndex: chunkMeta.meta.chunkIndex,
          chunkCount: chunkMeta.meta.chunkCount,
        },
        'Dropped live snapshot chunk that does not belong to the staged batch'
      );
      return;
    }

    // 同一批次内部乱序/块数对不上：socket.io 在同一条连接上保序，出现这种情况说明
    // 发送方状态已经错乱，整批作废最安全（主播端每次 (重)连都会重发完整批次）。
    if (
      staging.expectedChunks !== chunkMeta.meta.chunkCount ||
      staging.receivedChunks !== chunkMeta.meta.chunkIndex
    ) {
      socket.data.snapshotStaging = undefined;
      liveShareLogger.warn(
        {
          socketId: socket.id,
          sessionId,
          chunkIndex: chunkMeta.meta.chunkIndex,
          chunkCount: chunkMeta.meta.chunkCount,
          receivedChunks: staging.receivedChunks,
        },
        'Dropped out-of-order live snapshot chunk and discarded the staged batch'
      );
      return;
    }

    mergeSnapshotChunk(staging.snapshot, payload);
    staging.receivedChunks += 1;
    if (staging.receivedChunks >= staging.expectedChunks) {
      staging.snapshot.updatedAt = Date.now();
      snapshots.set(sessionId, staging.snapshot);
      socket.data.snapshotStaging = undefined;
    }
    return;
  }

  const ext = payload as {
    previewText?: StreamingPreviewText | string;
    previewTranslation?: StreamingPreviewTranslation | string;
    sourceLang?: string;
    targetLang?: string;
    translationMode?: string;
  };

  const rawSegmentCount = Array.isArray(payload.segments)
    ? payload.segments.length
    : 0;
  const rawSummaryCount = Array.isArray(payload.summaryBlocks)
    ? payload.summaryBlocks.length
    : 0;
  const rawTranslationCount =
    payload.translations && typeof payload.translations === 'object'
      ? Object.keys(payload.translations).length
      : 0;
  if (
    rawSegmentCount > MAX_SNAPSHOT_SEGMENTS ||
    rawSummaryCount > MAX_SNAPSHOT_SUMMARY_BLOCKS ||
    rawTranslationCount > MAX_SNAPSHOT_TRANSLATIONS
  ) {
    liveShareLogger.warn(
      {
        socketId: socket.id,
        sessionId,
        rawSegmentCount,
        rawSummaryCount,
        rawTranslationCount,
      },
      'sync_snapshot exceeded size limits; snapshot truncated'
    );
  }

  const nextSnapshot: LiveSnapshot = {
    segments: clampArray(payload.segments, MAX_SNAPSHOT_SEGMENTS).map(
      sanitizeSegment
    ),
    translations: sanitizeSnapshotTranslations(payload.translations),
    summaryBlocks: clampArray(
      payload.summaryBlocks,
      MAX_SNAPSHOT_SUMMARY_BLOCKS
    ).map(sanitizeSummaryBlock),
    status: typeof payload.status === 'string' ? payload.status : null,
    previewText: ext.previewText
      ? normalizePreviewText(ext.previewText)
      : EMPTY_STREAMING_PREVIEW_TEXT,
    previewTranslation: ext.previewTranslation
      ? normalizePreviewTranslation(ext.previewTranslation)
      : EMPTY_STREAMING_PREVIEW_TRANSLATION,
    sourceLang: typeof ext.sourceLang === 'string' ? ext.sourceLang : null,
    targetLang: typeof ext.targetLang === 'string' ? ext.targetLang : null,
    translationMode:
      typeof ext.translationMode === 'string' ? ext.translationMode : null,
    truncated: (payload as { truncated?: unknown }).truncated === true,
    updatedAt: Date.now(),
  };

  if (chunkMeta.kind === 'chunk' && chunkMeta.meta.chunkCount > 1) {
    // 多块批次的首块：先暂存，集齐才提交（见函数头注释）。旧快照在这期间保持不变，
    // 期间 join 的观众读到的是**上一份完整快照**（或磁盘草稿），不会是半份。
    socket.data.snapshotStaging = {
      chunkId: chunkMeta.meta.chunkId,
      expectedChunks: chunkMeta.meta.chunkCount,
      receivedChunks: 1,
      snapshot: nextSnapshot,
    } satisfies SnapshotStaging;
    return;
  }

  socket.data.snapshotStaging = undefined;
  snapshots.set(sessionId, nextSnapshot);
}

/**
 * H1：把一个续块并进暂存快照。刻意复用 mergeTranscriptSegment / mergeSummaryBlock
 * 与译文条目上限 —— 它们已经带了 U24 的「增量路径不得绕过条数上限」守卫，也按 id
 * 去重，所以重复块（极端时序下同一批次被重发）是幂等的。
 * 续块只带三大集合；status / preview / 语言等头部字段只随首块来（见 I3）。
 */
function mergeSnapshotChunk(
  snapshot: LiveSnapshot,
  payload: Partial<LiveSnapshot>
) {
  if (Array.isArray(payload.segments)) {
    for (const segment of payload.segments) {
      mergeTranscriptSegment(snapshot, segment);
    }
  }
  if (Array.isArray(payload.summaryBlocks)) {
    for (const block of payload.summaryBlocks) {
      mergeSummaryBlock(snapshot, block);
    }
  }

  const translations = sanitizeSnapshotTranslations(payload.translations);
  for (const [key, value] of Object.entries(translations)) {
    const isNewKey = !Object.prototype.hasOwnProperty.call(
      snapshot.translations,
      key
    );
    if (
      !isNewKey ||
      Object.keys(snapshot.translations).length < MAX_SNAPSHOT_TRANSLATIONS
    ) {
      snapshot.translations[key] = value;
    }
  }
}

async function handleBroadcast(
  socket: Socket,
  emitError: (message: string) => void,
  event: LiveEventPayload
) {
  if (!socket.data.isHost) {
    emitError('Only the broadcaster may publish events');
    return;
  }

  if (
    !event ||
    typeof event !== 'object' ||
    typeof event.type !== 'string' ||
    typeof event.timestamp !== 'number'
  ) {
    emitError('Invalid broadcast payload');
    return;
  }

  const sessionId = socket.data.sessionId as string;
  const snapshot = await getSessionSnapshot(sessionId);
  mergeEventIntoSnapshot(snapshot, event);
  snapshots.set(sessionId, snapshot);

  liveShareLogger.debug(
    {
      socketId: socket.id,
      sessionId,
      eventType: event.type,
    },
    'Broadcasted live share event'
  );

  socket.to(getRoomId(sessionId)).emit(event.type, event.payload);
}

/**
 * 装载实时分享逻辑，返回一个 teardown 函数：清掉 U61 的 TTL 清扫定时器与所有
 * 未决的 host 下线宽限计时，并清空快照 Map。生产环境 setupLiveShare 仅调用一次，
 * teardown 主要用于测试隔离与优雅关停（避免模块级定时器 / 快照跨用例泄漏）。
 */
export function setupLiveShare(io: SocketIO): () => void {
  // U61：后台 TTL 清扫僵尸快照。unref 避免阻塞进程退出。
  const sweepTimer = setInterval(() => {
    void sweepStaleSnapshots(io).catch(() => undefined);
  }, SNAPSHOT_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  // SHARE-REVOKE-001：周期复核所有房间的观众 token，兜底"撤销通知丢失/链接自然
  // 过期"两类没有即时驱逐信号的失效。撤销主路径由内部通知即时触发,不等这个周期。
  const revalidateTimer = setInterval(() => {
    void revalidateAllLiveRooms(io).catch(() => undefined);
  }, VIEWER_REVALIDATE_INTERVAL_MS);
  revalidateTimer.unref?.();

  io.on('connection', async (socket) => {
    const emitError = createShareErrorHandler(socket);

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
    // 下面 await 之前若先 reject 会触发 unhandledRejection；挂一个空 catch 占位，
    // 真正的失败处理仍在下面的 try/catch 里（同一个 promise 可被多次 await）。
    broadcasterAuth?.catch(() => undefined);
    const awaitBroadcasterAuth = async () => {
      if (!broadcasterAuth) return;
      try {
        await broadcasterAuth;
      } catch {
        // 鉴权失败：isHost 保持未置位，由各 handler 的 isHost 守卫拒绝
      }
    };

    socket.on('sync_snapshot', async (payload: Partial<LiveSnapshot>) => {
      await awaitBroadcasterAuth();
      handleSyncSnapshot(socket, emitError, payload);
    });

    socket.on('broadcast', async ({ event }: { event: LiveEventPayload }) => {
      await awaitBroadcasterAuth();
      await handleBroadcast(socket, emitError, event);
    });

    if (hasBroadcasterAuth) {
      try {
        await broadcasterAuth;
        const sessionId = socket.data.sessionId as string;
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
        const snapshot = await getSessionSnapshot(sessionId);
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

    socket.on('join', async ({ shareToken }: ViewerJoinPayload) => {
      // L5：先过每 socket join 预算，再碰 DB —— 守卫必须在查询之前，否则等于没守。
      if (!consumeJoinToken(socket)) {
        liveShareLogger.warn(
          { socketId: socket.id, clientIp: socket.data.clientIp },
          'Throttled live share join flood'
        );
        emitError('Too many join attempts');
        return;
      }

      try {
        const safeToken = sanitizeToken(shareToken ?? '');
        const link = await resolveViewerLink(safeToken);
        const sessionId = link.sessionId;

        // 安全：一个 socket 反复 join 不同 token 时，先退出上一个房间并刷新其计数，
        // 避免跨房间累积成员资格（viewer_count 虚高）以及被滥用强制驻留多房间。
        const previousSessionId = socket.data.sessionId as string | undefined;
        if (previousSessionId && previousSessionId !== sessionId) {
          socket.leave(getRoomId(previousSessionId));
          await emitViewerCount(io, previousSessionId);
        }

        socket.data.isHost = false;
        socket.data.sessionId = sessionId;
        // SHARE-REVOKE-001：记录观众所持 token，撤销/过期复核时按它重新校验；
        // 没有这条记录就无法定位"持已撤销 token 的 socket"。
        socket.data.shareToken = safeToken;
        socket.join(getRoomId(sessionId));

        liveShareLogger.info(
          {
            socketId: socket.id,
            sessionId,
            role: 'viewer',
          },
          'Viewer joined live share session'
        );

        const snapshot = await getSessionSnapshot(sessionId);
        socket.emit('initial_state', snapshot);
        await emitViewerCount(io, sessionId);
      } catch (error) {
        liveShareLogger.warn(
          {
            socketId: socket.id,
            err: serializeError(error),
          },
          'Viewer failed to join live share session'
        );
        emitError(error instanceof Error ? error.message : 'Failed to join live share');
      }
    });

    socket.on('disconnect', async () => {
      const sessionId = socket.data.sessionId as string | undefined;
      if (!sessionId) {
        return;
      }

      if (socket.data.isHost) {
        // C3/U11：不立即宣告 SHARE_OFFLINE / 删除快照，先起宽限计时。若主播在窗口内
        // 于新 socket 上重连，authenticateBroadcaster 会 cancelPendingHostOffline 取消
        // 本计时并保留快照；只有窗口内未回来才广播下线并回收内存。计时器 unref，避免
        // 阻塞进程退出。回调内再次核验房间内确无主播 socket，防止极端时序下误报下线。
        cancelPendingHostOffline(sessionId);
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
            io.to(getRoomId(sessionId)).emit('status_update', { status: 'SHARE_OFFLINE' });
            // 宽限期满仍无主播：回收内存快照，防止无限增长。
            snapshots.delete(sessionId);
          })();
        }, HOST_OFFLINE_GRACE_MS);
        timer.unref?.();
        pendingHostOffline.set(sessionId, timer);
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
    snapshots.clear();
  };
}
