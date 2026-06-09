// src/lib/liveShare/server.ts
// 服务端 socket.io 实时分享逻辑

import fs from 'fs/promises';
import path from 'path';
import { Server as SocketIO, Socket } from 'socket.io';
import { prisma } from '@/lib/prisma';
import { assertWithinRoot, sanitizePath, sanitizeToken } from '@/lib/security';
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
import type {
  StreamingPreviewText,
  StreamingPreviewTranslation,
} from '@/types/transcript';

const TRANSCRIPT_DIR = path.join(process.cwd(), 'data', 'transcripts');
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
  updatedAt: number;
}

interface ViewerJoinPayload {
  shareToken?: string;
}

const snapshots = new Map<string, LiveSnapshot>();

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
    updatedAt: Date.now(),
  };
}

function readSessionTranscriptPath(sessionId: string) {
  const safeSessionId = sanitizePath(sessionId);
  const fullPath = path.join(TRANSCRIPT_DIR, `${safeSessionId}.json`);
  assertWithinRoot(fullPath, TRANSCRIPT_DIR);
  return fullPath;
}

async function loadPersistedSnapshot(sessionId: string): Promise<LiveSnapshot> {
  try {
    const fullPath = readSessionTranscriptPath(sessionId);
    const raw = await fs.readFile(fullPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      segments?: unknown[];
      translations?: Record<string, string>;
      summaries?: unknown[];
      status?: string;
    };

    return {
      segments: Array.isArray(parsed.segments) ? parsed.segments : [],
      translations:
        parsed.translations && typeof parsed.translations === 'object'
          ? parsed.translations
          : {},
      summaryBlocks: Array.isArray(parsed.summaries) ? parsed.summaries : [],
      status: typeof parsed.status === 'string' ? parsed.status : null,
      previewText: EMPTY_STREAMING_PREVIEW_TEXT,
      previewTranslation: EMPTY_STREAMING_PREVIEW_TRANSLATION,
      sourceLang: null,
      targetLang: null,
      translationMode: null,
      updatedAt: Date.now(),
    };
  } catch {
    return buildEmptySnapshot();
  }
}

async function getSessionSnapshot(sessionId: string): Promise<LiveSnapshot> {
  const inMemory = snapshots.get(sessionId);
  if (inMemory) {
    return inMemory;
  }

  const persisted = await loadPersistedSnapshot(sessionId);
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
    snapshot.segments.push(segment);
    return snapshot;
  }

  const index = snapshot.segments.findIndex((item) => {
    if (!item || typeof item !== 'object') return false;
    return (item as { id?: string }).id === maybeSegment.id;
  });

  if (index === -1) {
    snapshot.segments.push(segment);
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
    snapshot.summaryBlocks.push(block);
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
        snapshot.translations[payload.segmentId] =
          payload.translation.length > MAX_TRANSLATION_LENGTH
            ? payload.translation.slice(0, MAX_TRANSLATION_LENGTH)
            : payload.translation;
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

export function setupLiveShare(io: SocketIO) {
  io.on('connection', async (socket) => {
    const emitError = createShareErrorHandler(socket);

    if ((socket.handshake.auth as BroadcasterAuthPayload | undefined)?.token) {
      try {
        await authenticateBroadcaster(socket);
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

    socket.on('sync_snapshot', async (payload: Partial<LiveSnapshot>) => {
      if (!socket.data.isHost) {
        emitError('Only the broadcaster may sync snapshots');
        return;
      }

      const sessionId = socket.data.sessionId as string;
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
        translationMode: typeof ext.translationMode === 'string' ? ext.translationMode : null,
        updatedAt: Date.now(),
      };

      snapshots.set(sessionId, nextSnapshot);
    });

    socket.on('broadcast', async ({ event }: { event: LiveEventPayload }) => {
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
    });

    socket.on('disconnect', async () => {
      const sessionId = socket.data.sessionId as string | undefined;
      if (!sessionId) {
        return;
      }

      if (socket.data.isHost) {
        io.to(getRoomId(sessionId)).emit('status_update', { status: 'SHARE_OFFLINE' });
        // 安全：broadcaster 断开时清理内存中的 snapshot，防止无限增长
        snapshots.delete(sessionId);
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
}
