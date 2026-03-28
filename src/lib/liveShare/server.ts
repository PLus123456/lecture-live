// src/lib/liveShare/server.ts
// 服务端 socket.io 实时分享逻辑

import fs from 'fs/promises';
import path from 'path';
import { Server as SocketIO, Socket } from 'socket.io';
import { prisma } from '@/lib/prisma';
import { assertWithinRoot, sanitizePath, sanitizeToken } from '@/lib/security';
import { logger, serializeError } from '@/lib/logger';
import {
  CLIENT_SESSION_TOKEN,
  extractTokenFromCookieHeader,
  verifyAuthToken,
} from '@/lib/auth';

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
  preview: string;
  previewTranslation: string;
  updatedAt: number;
}

interface ViewerJoinPayload {
  shareToken?: string;
}

const snapshots = new Map<string, LiveSnapshot>();

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
    preview: '',
    previewTranslation: '',
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
      preview: '',
      previewTranslation: '',
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
        const payload = event.payload as { segmentId: string; translation: string };
        snapshot.translations[payload.segmentId] = payload.translation;
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
        const p = event.payload as { preview?: string; previewTranslation?: string };
        snapshot.preview = typeof p.preview === 'string' ? p.preview : '';
        snapshot.previewTranslation = typeof p.previewTranslation === 'string' ? p.previewTranslation : '';
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
      const nextSnapshot: LiveSnapshot = {
        segments: Array.isArray(payload.segments) ? payload.segments : [],
        translations:
          payload.translations && typeof payload.translations === 'object'
            ? payload.translations
            : {},
        summaryBlocks: Array.isArray(payload.summaryBlocks)
          ? payload.summaryBlocks
          : [],
        status: typeof payload.status === 'string' ? payload.status : null,
        preview: typeof (payload as Record<string, unknown>).preview === 'string'
          ? (payload as Record<string, unknown>).preview as string : '',
        previewTranslation: typeof (payload as Record<string, unknown>).previewTranslation === 'string'
          ? (payload as Record<string, unknown>).previewTranslation as string : '',
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
