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
  jsonByteLength,
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
// id / 译文 key 的长度上限（与 sessionApi 的 maxIdUtf8Bytes 同量级）。超长整条丢弃而不截断——
// 截断会让两个不同的 id 撞成同一个 key、互相覆盖。
const MAX_RECORD_KEY_LENGTH = 256;
// speaker / language / timestamp / status / 语言元数据等短字段（与 sessionApi maxMetadataUtf8Bytes 同量级）
const MAX_METADATA_LENGTH = 256;
// 摘要块 keyPoints / suggestedQuestions 条数与 definitions 条目数（与 sessionApi 同口径）
const MAX_SUMMARY_LIST_ITEMS = 200;
const MAX_SUMMARY_DEFINITIONS = 200;
const UNSAFE_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 单场直播内存快照的总字节预算（UTF-8 JSON 口径，三大集合合计）。
 *
 * 只有「条数 + 单条文本长度」两道闸时，总量上界是 条数上限 × 单条消息上限（100KB）：
 * 一个已登录用户给自己的会话开直播，用塞了大字段的增量就能让单场快照涨到 GB 级，
 * WS 进程堆溢出崩溃（裸机 unit 是 BindsTo + Restart=no，Web 随之一起停）。现在：
 *   ① 单条按白名单重建（未知字段丢弃、各字段封顶），
 *   ② 整场按本预算记账，超限时丢最早的内容（与 trimSnapshotToByteBudget 同一取舍：
 *      最新内容价值最高），并置 truncated 让晚加入的观众知道历史不全。
 * 主播端单次全量同步最多 ~1.3MB（MAX_SYNC_SNAPSHOT_CHUNKS × 56KB），这里留足 3 倍余量，
 * 正常的长课堂（5 小时+）不会触发裁剪。
 */
export const MAX_LIVE_SNAPSHOT_BYTES = 4 * 1024 * 1024;
// 裁到预算的 3/4：留出回差，避免此后每条增量都触发一次整场重算。
const LIVE_SNAPSHOT_TRIM_TARGET_BYTES = 3 * 1024 * 1024;

// 截断超量数组，保护服务端内存（非数组归一为空数组）
function clampArray(input: unknown, max: number): unknown[] {
  if (!Array.isArray(input)) return [];
  return input.length > max ? input.slice(0, max) : input;
}

function clampText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isSafeRecordKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_RECORD_KEY_LENGTH &&
    !UNSAFE_RECORD_KEYS.has(value)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined) target[key] = value;
}

function sanitizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (out.length >= MAX_SUMMARY_LIST_ITEMS) break;
    const text = clampText(item, MAX_TRANSLATION_LENGTH);
    if (text !== undefined) out.push(text);
  }
  return out;
}

/**
 * 按白名单重建 transcript segment（字段与 sessionApi 的 SEGMENT_KEYS 同口径）：未知字段一律
 * 丢弃、文本封顶 MAX_TRANSLATION_LENGTH、短字段封顶 MAX_METADATA_LENGTH、类型不符的字段不带。
 * 不补默认值——缺什么就缺什么，观众端行为与原样转发一致。
 * 返回 null = 整条丢弃（非对象，或 id 存在但不合法）。
 */
function sanitizeSegment(segment: unknown): Record<string, unknown> | null {
  if (!isPlainObject(segment)) return null;
  const out: Record<string, unknown> = {};
  if (segment.id !== undefined) {
    if (!isSafeRecordKey(segment.id)) return null;
    out.id = segment.id;
  }
  setIfDefined(out, 'sessionIndex', finiteNumber(segment.sessionIndex));
  setIfDefined(out, 'speaker', clampText(segment.speaker, MAX_METADATA_LENGTH));
  setIfDefined(out, 'language', clampText(segment.language, MAX_METADATA_LENGTH));
  setIfDefined(out, 'text', clampText(segment.text, MAX_TRANSLATION_LENGTH));
  setIfDefined(
    out,
    'translatedText',
    clampText(segment.translatedText, MAX_TRANSLATION_LENGTH)
  );
  for (const key of ['globalStartMs', 'globalEndMs', 'startMs', 'endMs', 'confidence']) {
    setIfDefined(out, key, finiteNumber(segment[key]));
  }
  if (typeof segment.isFinal === 'boolean') out.isFinal = segment.isFinal;
  setIfDefined(out, 'timestamp', clampText(segment.timestamp, MAX_METADATA_LENGTH));
  return out;
}

/**
 * 按白名单重建 summary block（SUMMARY_KEYS + 旧版 SummarizeResponse 的 LEGACY 字段）：
 * summary / keyPoints[*] / definitions 各 value / suggestedQuestions[*] 封顶
 * MAX_TRANSLATION_LENGTH，列表与 definitions 条目数封顶，timeRange 只保留数值起止（或旧版字符串）。
 * 返回 null = 整条丢弃（非对象，或 id 存在但不合法）。
 */
function sanitizeSummaryBlock(block: unknown): Record<string, unknown> | null {
  if (!isPlainObject(block)) return null;
  const out: Record<string, unknown> = {};
  if (block.id !== undefined) {
    if (!isSafeRecordKey(block.id)) return null;
    out.id = block.id;
  }
  setIfDefined(out, 'blockIndex', finiteNumber(block.blockIndex));

  if (typeof block.timeRange === 'string') {
    out.timeRange = clampText(block.timeRange, MAX_METADATA_LENGTH);
  } else if (isPlainObject(block.timeRange)) {
    const timeRange: Record<string, unknown> = {};
    setIfDefined(timeRange, 'startMs', finiteNumber(block.timeRange.startMs));
    setIfDefined(timeRange, 'endMs', finiteNumber(block.timeRange.endMs));
    out.timeRange = timeRange;
  }

  setIfDefined(out, 'keyPoints', sanitizeStringList(block.keyPoints));
  if (isPlainObject(block.definitions)) {
    const definitions: Record<string, string> = {};
    let count = 0;
    for (const [term, definition] of Object.entries(block.definitions)) {
      if (count >= MAX_SUMMARY_DEFINITIONS) break;
      const text = clampText(definition, MAX_TRANSLATION_LENGTH);
      if (!isSafeRecordKey(term) || text === undefined) continue;
      definitions[term] = text;
      count += 1;
    }
    out.definitions = definitions;
  }
  setIfDefined(out, 'summary', clampText(block.summary, MAX_TRANSLATION_LENGTH));
  setIfDefined(out, 'suggestedQuestions', sanitizeStringList(block.suggestedQuestions));
  if (typeof block.frozen === 'boolean') out.frozen = block.frozen;
  setIfDefined(out, 'timestamp', finiteNumber(block.timestamp));
  return out;
}

// 清洗 sync_snapshot 的 translations：key 须是合法记录键（长度封顶、拒原型链键），
// 仅接受 string 值，单条长度封顶 + 条目数封顶
function sanitizeSnapshotTranslations(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (count >= MAX_SNAPSHOT_TRANSLATIONS) break;
    if (!isSafeRecordKey(key) || typeof value !== 'string') continue;
    out[key] =
      value.length > MAX_TRANSLATION_LENGTH
        ? value.slice(0, MAX_TRANSLATION_LENGTH)
        : value;
    count += 1;
  }
  return out;
}

// 列表版：先按条数上限截断，再逐条白名单重建，丢弃不合法的条目。
function sanitizeSegmentList(input: unknown): Record<string, unknown>[] {
  return clampArray(input, MAX_SNAPSHOT_SEGMENTS)
    .map(sanitizeSegment)
    .filter((segment): segment is Record<string, unknown> => segment !== null);
}

function sanitizeSummaryBlockList(input: unknown): Record<string, unknown>[] {
  return clampArray(input, MAX_SNAPSHOT_SUMMARY_BLOCKS)
    .map(sanitizeSummaryBlock)
    .filter((block): block is Record<string, unknown> => block !== null);
}

// ── 快照字节记账（MAX_LIVE_SNAPSHOT_BYTES）────────────────────────────────────
// 口径与 snapshotChunking.trimSnapshotToByteBudget 一致：每条 JSON 字节 + 分隔符。
// 记账值挂在 WeakMap 上而不是快照对象里：快照对象会原样作为 initial_state 发给观众。
const snapshotByteUsage = new WeakMap<LiveSnapshot, number>();

function itemBytes(item: unknown): number {
  return jsonByteLength(item) + 1;
}

function translationEntryBytes(key: string, value: string): number {
  return jsonByteLength(key) + jsonByteLength(value) + 2;
}

function measureSnapshotBytes(snapshot: LiveSnapshot): number {
  let bytes = 0;
  for (const segment of snapshot.segments) bytes += itemBytes(segment);
  for (const block of snapshot.summaryBlocks) bytes += itemBytes(block);
  for (const [key, value] of Object.entries(snapshot.translations)) {
    bytes += translationEntryBytes(key, value);
  }
  return bytes;
}

function getSnapshotBytes(snapshot: LiveSnapshot): number {
  let bytes = snapshotByteUsage.get(snapshot);
  if (bytes === undefined) {
    bytes = measureSnapshotBytes(snapshot);
    snapshotByteUsage.set(snapshot, bytes);
  }
  return bytes;
}

function addSnapshotBytes(snapshot: LiveSnapshot, delta: number) {
  snapshotByteUsage.set(snapshot, getSnapshotBytes(snapshot) + delta);
}

function segmentIdOf(segment: unknown): string | null {
  if (!segment || typeof segment !== 'object') return null;
  const id = (segment as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

/**
 * 超出 MAX_LIVE_SNAPSHOT_BYTES 时就地裁到 LIVE_SNAPSHOT_TRIM_TARGET_BYTES：依次丢最早的
 * segment（连同它的译文）→ 最早的摘要块 → 最早写入的孤儿译文，保证一定能回到预算内。
 */
function enforceLiveSnapshotBudget(snapshot: LiveSnapshot, sessionId: string) {
  let bytes = getSnapshotBytes(snapshot);
  if (bytes <= MAX_LIVE_SNAPSHOT_BYTES) return;

  let droppedSegments = 0;
  while (
    bytes > LIVE_SNAPSHOT_TRIM_TARGET_BYTES &&
    droppedSegments < snapshot.segments.length
  ) {
    const segment = snapshot.segments[droppedSegments];
    bytes -= itemBytes(segment);
    const id = segmentIdOf(segment);
    if (id !== null && Object.prototype.hasOwnProperty.call(snapshot.translations, id)) {
      bytes -= translationEntryBytes(id, snapshot.translations[id]);
      delete snapshot.translations[id];
    }
    droppedSegments += 1;
  }
  if (droppedSegments > 0) snapshot.segments.splice(0, droppedSegments);

  let droppedSummaryBlocks = 0;
  while (
    bytes > LIVE_SNAPSHOT_TRIM_TARGET_BYTES &&
    droppedSummaryBlocks < snapshot.summaryBlocks.length
  ) {
    bytes -= itemBytes(snapshot.summaryBlocks[droppedSummaryBlocks]);
    droppedSummaryBlocks += 1;
  }
  if (droppedSummaryBlocks > 0) snapshot.summaryBlocks.splice(0, droppedSummaryBlocks);

  let droppedTranslations = 0;
  if (bytes > LIVE_SNAPSHOT_TRIM_TARGET_BYTES) {
    for (const key of Object.keys(snapshot.translations)) {
      if (bytes <= LIVE_SNAPSHOT_TRIM_TARGET_BYTES) break;
      bytes -= translationEntryBytes(key, snapshot.translations[key]);
      delete snapshot.translations[key];
      droppedTranslations += 1;
    }
  }

  snapshot.truncated = true;
  snapshotByteUsage.set(snapshot, Math.max(0, bytes));
  liveShareLogger.warn(
    {
      sessionId,
      droppedSegments,
      droppedSummaryBlocks,
      droppedTranslations,
      budgetBytes: MAX_LIVE_SNAPSHOT_BYTES,
    },
    'Live snapshot exceeded its byte budget; dropped the oldest content'
  );
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
    segments: sanitizeSegmentList(parsed.segments),
    summaryBlocks: sanitizeSummaryBlockList(parsed.summaries),
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
    status: clampText(parsed.status, MAX_METADATA_LENGTH) ?? null,
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

// 以下 store* 只接收已经过 sanitize* 白名单重建的条目，并负责条数上限与字节记账。

function storeSegment(snapshot: LiveSnapshot, segment: Record<string, unknown>) {
  const id = typeof segment.id === 'string' ? segment.id : null;
  const index =
    id === null
      ? -1
      : snapshot.segments.findIndex((item) => segmentIdOf(item) === id);

  if (index === -1) {
    // 新 id / 无 id（只能追加、无法去重）：仅在未达上限时追加，防止 broadcast
    // 增量路径绕过 sync_snapshot 的 MAX_SNAPSHOT_SEGMENTS（U24）。
    if (snapshot.segments.length < MAX_SNAPSHOT_SEGMENTS) {
      snapshot.segments.push(segment);
      addSnapshotBytes(snapshot, itemBytes(segment));
    }
    return;
  }

  // 已存在的 id 走原地替换，不增长条数（字节按新旧差值记账）。
  addSnapshotBytes(snapshot, itemBytes(segment) - itemBytes(snapshot.segments[index]));
  snapshot.segments[index] = segment;
}

function storeSummaryBlock(snapshot: LiveSnapshot, block: Record<string, unknown>) {
  const blockId = typeof block.id === 'string' ? block.id : null;
  const blockIndex = typeof block.blockIndex === 'number' ? block.blockIndex : null;
  const index = snapshot.summaryBlocks.findIndex((item) => {
    if (!item || typeof item !== 'object') return false;
    const existing = item as { id?: unknown; blockIndex?: unknown };
    if (blockId !== null && typeof existing.id === 'string') {
      return existing.id === blockId;
    }
    if (blockIndex !== null && typeof existing.blockIndex === 'number') {
      return existing.blockIndex === blockIndex;
    }
    return false;
  });

  if (index === -1) {
    // 新增 summary block：仅在未达上限时追加，防止 broadcast 增量路径绕过
    // MAX_SNAPSHOT_SUMMARY_BLOCKS（U24）。已存在的走原地替换，不增长。
    if (snapshot.summaryBlocks.length < MAX_SNAPSHOT_SUMMARY_BLOCKS) {
      snapshot.summaryBlocks.push(block);
      addSnapshotBytes(snapshot, itemBytes(block));
    }
    return;
  }

  addSnapshotBytes(snapshot, itemBytes(block) - itemBytes(snapshot.summaryBlocks[index]));
  snapshot.summaryBlocks[index] = block;
}

/** key 须已过 isSafeRecordKey、value 已封顶。 */
function storeTranslation(snapshot: LiveSnapshot, key: string, value: string) {
  const exists = Object.prototype.hasOwnProperty.call(snapshot.translations, key);
  // 新 key 达到条目上限时拒绝新增，防止 broadcast 增量路径绕过
  // MAX_SNAPSHOT_TRANSLATIONS（U24）。已存在的 key 走覆盖，不增长。
  if (!exists && Object.keys(snapshot.translations).length >= MAX_SNAPSHOT_TRANSLATIONS) {
    return;
  }
  const previousBytes = exists
    ? translationEntryBytes(key, snapshot.translations[key])
    : 0;
  snapshot.translations[key] = value;
  addSnapshotBytes(snapshot, translationEntryBytes(key, value) - previousBytes);
}

interface SanitizedTranslationDelta {
  segmentId: string;
  translation: string;
  sourceLang?: string;
  targetLang?: string;
  translationMode?: string;
}

/**
 * 把一条 broadcast 增量按事件类型白名单重建。返回 null = 不认识的类型 / 载荷不合法，
 * 整条丢弃：既不并入快照，也不转发给观众（观众端只认这五种事件，转发其它名字无意义，
 * 转发 socket.io 保留名还会让 emit 直接抛错）。转发给观众的也是重建后的载荷，
 * 保证实时观众与晚加入观众（initial_state）看到的是同一份数据。
 */
function sanitizeLiveEventPayload(type: string, payload: unknown): unknown | null {
  switch (type) {
    case 'transcript_delta':
      return sanitizeSegment(payload);
    case 'summary_update':
      return sanitizeSummaryBlock(payload);
    case 'translation_delta': {
      if (!isPlainObject(payload)) return null;
      const translation = clampText(payload.translation, MAX_TRANSLATION_LENGTH);
      if (!isSafeRecordKey(payload.segmentId) || translation === undefined) return null;
      const out: SanitizedTranslationDelta = {
        segmentId: payload.segmentId,
        translation,
      };
      const sourceLang = clampText(payload.sourceLang, MAX_METADATA_LENGTH);
      const targetLang = clampText(payload.targetLang, MAX_METADATA_LENGTH);
      const translationMode = clampText(payload.translationMode, MAX_METADATA_LENGTH);
      if (sourceLang !== undefined) out.sourceLang = sourceLang;
      if (targetLang !== undefined) out.targetLang = targetLang;
      if (translationMode !== undefined) out.translationMode = translationMode;
      return out;
    }
    case 'status_update': {
      if (!isPlainObject(payload)) return null;
      const status = clampText(payload.status, MAX_METADATA_LENGTH);
      return status === undefined ? null : { status };
    }
    case 'preview_update': {
      if (!isPlainObject(payload)) return null;
      const p = payload as {
        previewText?: StreamingPreviewText | string;
        previewTranslation?: StreamingPreviewTranslation | string;
      };
      return {
        previewText: p.previewText
          ? normalizePreviewText(p.previewText)
          : EMPTY_STREAMING_PREVIEW_TEXT,
        previewTranslation: p.previewTranslation
          ? normalizePreviewTranslation(p.previewTranslation)
          : EMPTY_STREAMING_PREVIEW_TRANSLATION,
      };
    }
    default:
      return null;
  }
}

/** payload 必须是 sanitizeLiveEventPayload 对同一 type 的非 null 返回值。 */
function mergeEventIntoSnapshot(
  snapshot: LiveSnapshot,
  type: LiveEventPayload['type'],
  payload: unknown
): LiveSnapshot {
  switch (type) {
    case 'transcript_delta':
      storeSegment(snapshot, payload as Record<string, unknown>);
      break;
    case 'translation_delta': {
      const delta = payload as SanitizedTranslationDelta;
      storeTranslation(snapshot, delta.segmentId, delta.translation);
      // 更新翻译元数据（如果 delta 中携带）
      if (delta.sourceLang !== undefined) snapshot.sourceLang = delta.sourceLang;
      if (delta.targetLang !== undefined) snapshot.targetLang = delta.targetLang;
      if (delta.translationMode !== undefined) snapshot.translationMode = delta.translationMode;
      break;
    }
    case 'summary_update':
      storeSummaryBlock(snapshot, payload as Record<string, unknown>);
      break;
    case 'status_update':
      snapshot.status = (payload as { status: string }).status;
      break;
    case 'preview_update': {
      const preview = payload as {
        previewText: StreamingPreviewText;
        previewTranslation: StreamingPreviewTranslation;
      };
      snapshot.previewText = preview.previewText;
      snapshot.previewTranslation = preview.previewTranslation;
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
  // 记下主播握手所用的 token：撤销通知与周期兜底要按它复核归属
  // （见 revalidateSessionBroadcasters），否则主播这一侧永远踢不掉。
  socket.data.shareToken = shareToken;
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

/**
 * 主播侧复核：按 DB 当前状态重新校验某 session 房间里的主播 socket，驱逐已失去
 * 归属或链接已撤销/过期的连接。与观众复核同一条 fail-safe 原则 —— 判定只看 DB，
 * 与触发来源无关，被恶意/重复触发时合法主播原样保留。返回驱逐数。
 *
 * 存在的理由：撤销通知（internalHttp）与周期兜底都要能把「已经不该再推流的主播」
 * 断掉；只清观众的话，主播仍会持续把增量推给一个已撤销的房间。
 */
export async function revalidateSessionBroadcasters(
  io: SocketIO,
  sessionId: string,
  options: RevalidateViewersOptions = {}
): Promise<number> {
  const roomSockets = await io.in(getRoomId(sessionId)).fetchSockets();
  const hosts = roomSockets.filter((roomSocket) => roomSocket.data.isHost);
  if (hosts.length === 0) return 0;

  const tokens = [
    ...new Set(
      hosts
        .map((host) =>
          typeof host.data.shareToken === 'string' ? host.data.shareToken : null
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

  let revoked = 0;
  for (const host of hosts) {
    const token = host.data.shareToken;
    if (typeof token === 'string' && validTokens.has(token)) continue;

    if (!options.silent) {
      host.emit('share_error', {
        message: 'Share link revoked',
        code: 'SHARE_REVOKED',
      });
    }
    host.disconnect(true);
    revoked += 1;
  }

  if (revoked > 0) {
    liveShareLogger.info(
      { sessionId, revoked, silent: Boolean(options.silent) },
      'Disconnected live share broadcasters with revoked or expired links'
    );
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
      enforceLiveSnapshotBudget(staging.snapshot, sessionId);
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
    segments: sanitizeSegmentList(payload.segments),
    translations: sanitizeSnapshotTranslations(payload.translations),
    summaryBlocks: sanitizeSummaryBlockList(payload.summaryBlocks),
    status: clampText(payload.status, MAX_METADATA_LENGTH) ?? null,
    previewText: ext.previewText
      ? normalizePreviewText(ext.previewText)
      : EMPTY_STREAMING_PREVIEW_TEXT,
    previewTranslation: ext.previewTranslation
      ? normalizePreviewTranslation(ext.previewTranslation)
      : EMPTY_STREAMING_PREVIEW_TRANSLATION,
    sourceLang: clampText(ext.sourceLang, MAX_METADATA_LENGTH) ?? null,
    targetLang: clampText(ext.targetLang, MAX_METADATA_LENGTH) ?? null,
    translationMode: clampText(ext.translationMode, MAX_METADATA_LENGTH) ?? null,
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
  enforceLiveSnapshotBudget(nextSnapshot, sessionId);
  snapshots.set(sessionId, nextSnapshot);
}

/**
 * H1：把一个续块并进暂存快照。刻意复用 storeSegment / storeSummaryBlock / storeTranslation
 * —— 它们已经带了 U24 的「增量路径不得绕过条数上限」守卫与字节记账，也按 id 去重，
 * 所以重复块（极端时序下同一批次被重发）是幂等的。
 * 续块只带三大集合；status / preview / 语言等头部字段只随首块来（见 I3）。
 */
function mergeSnapshotChunk(
  snapshot: LiveSnapshot,
  payload: Partial<LiveSnapshot>
) {
  if (Array.isArray(payload.segments)) {
    for (const raw of payload.segments) {
      const segment = sanitizeSegment(raw);
      if (segment) storeSegment(snapshot, segment);
    }
  }
  if (Array.isArray(payload.summaryBlocks)) {
    for (const raw of payload.summaryBlocks) {
      const block = sanitizeSummaryBlock(raw);
      if (block) storeSummaryBlock(snapshot, block);
    }
  }

  const translations = sanitizeSnapshotTranslations(payload.translations);
  for (const [key, value] of Object.entries(translations)) {
    storeTranslation(snapshot, key, value);
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
  // 不认识的事件类型 / 不合法载荷：静默丢弃，不回 share_error —— 主播端收到 share_error
  // 会当成故障整条撤销分享链接（useLiveShare 的 teardown），版本错配不该升级成撤链。
  const payload = sanitizeLiveEventPayload(event.type, event.payload);
  if (payload === null) {
    liveShareLogger.debug(
      { socketId: socket.id, sessionId, eventType: event.type },
      'Dropped live share event with unknown type or malformed payload'
    );
    return;
  }

  const snapshot = await getSessionSnapshot(sessionId);
  mergeEventIntoSnapshot(snapshot, event.type, payload);
  enforceLiveSnapshotBudget(snapshot, sessionId);
  snapshots.set(sessionId, snapshot);

  liveShareLogger.debug(
    {
      socketId: socket.id,
      sessionId,
      eventType: event.type,
    },
    'Broadcasted live share event'
  );

  socket.to(getRoomId(sessionId)).emit(event.type, payload);
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
