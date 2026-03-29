import { NextResponse } from 'next/server';
import type { Prisma, SessionStatus as PrismaSessionStatus } from '@prisma/client';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  invalidateFoldersApiCache,
  invalidateSessionsApiCache,
  invalidateShareLinksApiCache,
} from '@/lib/apiResponseCache';
import { jsonWithCache } from '@/lib/httpCache';
import { assertOwnership } from '@/lib/security';
import {
  normalizeOptionalString,
  normalizeSessionAudioSource,
  normalizeSessionRegion,
} from '@/lib/sessionApi';
import {
  loadSessionAudioArtifact,
  loadSessionTranscriptBundle,
} from '@/lib/sessionPersistence';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await prisma.session.findUnique({
    where: { id: id },
  });

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  try {
    assertOwnership(user.id, session.userId);
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  return jsonWithCache(req, session, {
    cacheControl: 'private, no-cache, must-revalidate',
    vary: ['Authorization', 'Cookie'],
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await prisma.session.findUnique({
    where: { id: id },
  });

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  try {
    assertOwnership(user.id, session.userId);
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const body = await req.json();
  const nextStatusInput =
    body.status === undefined
      ? undefined
      : typeof body.status === 'string'
        ? body.status
        : null;

  if (nextStatusInput === null) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  const nextStatus = nextStatusInput as PrismaSessionStatus | undefined;

  // v2.1: validate status transitions — strict one-way lifecycle
  if (nextStatus) {
    const VALID_TRANSITIONS: Record<string, string[]> = {
      CREATED:    ['RECORDING'],
      RECORDING:  ['PAUSED', 'FINALIZING'],
      PAUSED:     ['RECORDING', 'FINALIZING'],
      FINALIZING: ['COMPLETED'],
      COMPLETED:  ['ARCHIVED'],
      ARCHIVED:   [],
    };
    // Allow idempotent (same-state) transitions
    if (nextStatus !== session.status) {
      const allowed = VALID_TRANSITIONS[session.status] || [];
      if (!allowed.includes(nextStatus)) {
        return NextResponse.json(
          { error: `Invalid status transition: ${session.status} → ${nextStatus}` },
          { status: 400 }
        );
      }
    }
  }

  let title: string | undefined;
  if (body.title !== undefined) {
    const normalizedTitle = normalizeOptionalString(body.title, 160);
    if (!normalizedTitle) {
      return NextResponse.json({ error: 'Invalid title' }, { status: 400 });
    }
    title = normalizedTitle;
  }

  let audioSource: string | undefined;
  if (body.audioSource !== undefined) {
    const normalizedAudioSource = normalizeSessionAudioSource(body.audioSource);
    if (!normalizedAudioSource) {
      return NextResponse.json(
        { error: 'Invalid audioSource' },
        { status: 400 }
      );
    }
    audioSource = normalizedAudioSource;
  }

  let sonioxRegion: string | undefined;
  if (body.sonioxRegion !== undefined) {
    const normalizedRegion = normalizeSessionRegion(body.sonioxRegion);
    if (!normalizedRegion) {
      return NextResponse.json(
        { error: 'Invalid sonioxRegion' },
        { status: 400 }
      );
    }
    sonioxRegion = normalizedRegion;
  }

  const durationMs =
    body.durationMs === undefined ? undefined : Number(body.durationMs);

  if (
    body.durationMs !== undefined &&
    (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0)
  ) {
    return NextResponse.json(
      { error: 'Invalid durationMs' },
      { status: 400 }
    );
  }

  if (nextStatus === 'COMPLETED') {
    const [audioArtifact, transcriptBundle] = await Promise.all([
      loadSessionAudioArtifact(session),
      loadSessionTranscriptBundle(session),
    ]);

    if (!audioArtifact) {
      return NextResponse.json(
        { error: 'Cannot complete session before audio is saved' },
        { status: 409 }
      );
    }

    if (!transcriptBundle) {
      return NextResponse.json(
        { error: 'Cannot complete session before transcript is saved' },
        { status: 409 }
      );
    }
  }

  const updated = await prisma.session.update({
    where: { id: id },
    data: buildSessionUpdateData({
      session,
      nextStatus,
      durationMs,
      title,
      audioSource,
      sonioxRegion,
    }),
  });

  await invalidateSessionsApiCache(user.id);
  return NextResponse.json(updated);
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await prisma.session.findUnique({
    where: { id: id },
  });

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  try {
    assertOwnership(user.id, session.userId);
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  // 先删除关联表记录（FolderSession / ShareLink），再删除 session
  await prisma.$transaction([
    prisma.folderSession.deleteMany({ where: { sessionId: id } }),
    prisma.shareLink.deleteMany({ where: { sessionId: id } }),
    prisma.session.delete({ where: { id: id } }),
  ]);
  await Promise.all([
    invalidateSessionsApiCache(user.id),
    invalidateFoldersApiCache(user.id),
    invalidateShareLinksApiCache(user.id),
  ]);
  return NextResponse.json({ success: true });
}

function buildSessionUpdateData(options: {
  session: {
    status: PrismaSessionStatus;
    serverStartedAt: Date | null;
    serverPausedAt: Date | null;
  };
  nextStatus?: PrismaSessionStatus;
  durationMs?: number;
  title?: string;
  audioSource?: string;
  sonioxRegion?: string;
}): Prisma.SessionUpdateInput {
  const now = new Date();
  const data: Prisma.SessionUpdateInput = {
    ...(options.title !== undefined && { title: options.title }),
    ...(options.nextStatus !== undefined && { status: options.nextStatus }),
    ...(options.durationMs !== undefined && { durationMs: options.durationMs }),
    ...(options.audioSource !== undefined && { audioSource: options.audioSource }),
    ...(options.sonioxRegion !== undefined && { sonioxRegion: options.sonioxRegion }),
  };

  const pausedAt =
    options.session.status === 'PAUSED' ? options.session.serverPausedAt : null;
  const sessionWasPaused = pausedAt !== null;
  const pendingPausedMs = sessionWasPaused
    ? Math.max(0, now.getTime() - pausedAt.getTime())
    : 0;

  if (options.nextStatus === 'RECORDING') {
    if (!options.session.serverStartedAt) {
      data.serverStartedAt = now;
      data.serverPausedMs = 0;
      data.serverPausedAt = null;
    } else if (sessionWasPaused) {
      data.serverPausedAt = null;
      if (pendingPausedMs > 0) {
        data.serverPausedMs = { increment: pendingPausedMs };
      }
    }
  }

  if (options.nextStatus === 'PAUSED') {
    data.serverPausedAt = options.session.serverPausedAt ?? now;
  }

  if (options.nextStatus === 'FINALIZING' && sessionWasPaused) {
    data.serverPausedAt = null;
    if (pendingPausedMs > 0) {
      data.serverPausedMs = { increment: pendingPausedMs };
    }
  }

  return data;
}
