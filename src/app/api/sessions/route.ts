import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceApiRateLimit } from '@/lib/rateLimit';
import { withRequestLogging } from '@/lib/requestLogger';
import {
  normalizeLanguageCode,
  normalizeOptionalString,
  normalizeSessionAudioSource,
  normalizeSessionRegion,
} from '@/lib/sessionApi';

export const GET = withRequestLogging('sessions:list', async (req: Request) => {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const unarchived = url.searchParams.get('unarchived') === 'true';
  const folderId = url.searchParams.get('folderId');

  const withCache = (data: unknown) => {
    const response = NextResponse.json(data);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };

  if (unarchived) {
    // 返回不属于任何文件夹的 session
    const sessions = await prisma.session.findMany({
      where: {
        userId: user.id,
        folders: { none: {} },
      },
      orderBy: { createdAt: 'desc' },
    });
    return withCache(sessions);
  }

  if (folderId) {
    // 返回指定文件夹中的 session
    const sessions = await prisma.session.findMany({
      where: {
        userId: user.id,
        folders: { some: { folderId } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return withCache(sessions);
  }

  // 支持分页：?limit=N&cursor=LAST_ID
  const limitParam = url.searchParams.get('limit');
  const cursor = url.searchParams.get('cursor');
  const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 200) : undefined;

  const sessions = await prisma.session.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    ...(limit ? { take: limit + 1 } : {}),
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  // 如果有分页参数，返回带 nextCursor 的响应
  if (limit) {
    const hasMore = sessions.length > limit;
    const items = hasMore ? sessions.slice(0, limit) : sessions;
    const nextCursor = hasMore ? items[items.length - 1].id : null;
    return withCache({ items, nextCursor });
  }

  return withCache(sessions);
});

export const POST = withRequestLogging('sessions:create', async (req: Request) => {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceApiRateLimit(req, {
    scope: 'sessions:create',
    windowMs: 10 * 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  try {
    const body = await req.json();
    const title = normalizeOptionalString(body.title, 160) ?? 'Untitled Session';
    const courseName = normalizeOptionalString(body.courseName, 160);
    const llmProvider = normalizeOptionalString(body.llmProvider, 64) ?? 'claude';
    const audioSource = normalizeSessionAudioSource(body.audioSource);
    const sonioxRegion = normalizeSessionRegion(body.sonioxRegion);
    const folderId =
      typeof body.folderId === 'string' && body.folderId.trim()
        ? body.folderId.trim()
        : null;

    if (body.audioSource !== undefined && !audioSource) {
      return NextResponse.json(
        { error: 'Invalid audioSource' },
        { status: 400 }
      );
    }

    if (body.sonioxRegion !== undefined && !sonioxRegion) {
      return NextResponse.json(
        { error: 'Invalid sonioxRegion' },
        { status: 400 }
      );
    }

    if (folderId) {
      const folder = await prisma.folder.findUnique({
        where: { id: folderId },
        select: { id: true, userId: true },
      });

      if (!folder) {
        return NextResponse.json({ error: 'Folder not found' }, { status: 404 });
      }

      if (folder.userId !== user.id) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      }
    }

    const session = await prisma.session.create({
      data: {
        userId: user.id,
        title,
        status: 'CREATED',
        courseName,
        sourceLang: normalizeLanguageCode(body.sourceLang, 'en'),
        targetLang: normalizeLanguageCode(body.targetLang, 'zh'),
        llmProvider,
        audioSource: audioSource ?? 'microphone',
        sonioxRegion: sonioxRegion ?? 'auto',
        ...(folderId
          ? { folders: { create: { folderId } } }
          : {}),
      },
    });

    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    console.error('Create session error:', error);
    return NextResponse.json(
      { error: 'Failed to create session' },
      { status: 500 }
    );
  }
});
