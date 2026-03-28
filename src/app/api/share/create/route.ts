import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { assertOwnership, parsePositiveInteger, sanitizeTextInput } from '@/lib/security';

const MAX_SHARE_HOURS = 24 * 7;

async function getOwnedSession(sessionId: string, userId: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    return null;
  }

  assertOwnership(userId, session.userId);
  return session;
}

export async function GET(req: Request) {
  const rateLimited = await enforceRateLimit(req, {
    scope: 'share:list',
    limit: 60,
    windowMs: 60_000,
  });
  if (rateLimited) {
    return rateLimited;
  }

  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const shareLinks = await prisma.shareLink.findMany({
      where: { createdBy: user.id },
      include: {
        session: {
          select: {
            id: true,
            title: true,
            status: true,
            createdAt: true,
            sourceLang: true,
            targetLang: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || new URL(req.url).origin;
    return NextResponse.json(
      shareLinks.map((link) => ({
        id: link.id,
        token: link.token,
        isLive: link.isLive,
        expiresAt: link.expiresAt,
        createdAt: link.createdAt,
        url: `${appBaseUrl}/session/${link.sessionId}/view?token=${link.token}`,
        session: link.session,
      }))
    );
  } catch (error) {
    console.error('List share links error:', error);
    return NextResponse.json(
      { error: 'Failed to load share links' },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const rateLimited = await enforceRateLimit(req, {
    scope: 'share:create',
    limit: 30,
    windowMs: 60_000,
  });
  if (rateLimited) {
    return rateLimited;
  }

  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const sessionId = sanitizeTextInput(body.sessionId, { maxLength: 64 });
    const isLive = body.isLive ?? false;

    if (!sessionId) {
      return NextResponse.json(
        { error: 'sessionId is required' },
        { status: 400 }
      );
    }

    let session;
    try {
      session = await getOwnedSession(sessionId, user.id);
    } catch {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    let expiresAt: Date | null = null;
    if (body.expiresInHours != null) {
      try {
        const expiresInHours = parsePositiveInteger(body.expiresInHours, {
          min: 1,
          max: MAX_SHARE_HOURS,
        });
        expiresAt = new Date(Date.now() + expiresInHours * 3600_000);
      } catch {
        return NextResponse.json(
          { error: `expiresInHours must be between 1 and ${MAX_SHARE_HOURS}` },
          { status: 400 }
        );
      }
    }

    const existingLiveLink = await prisma.shareLink.findFirst({
      where: {
        sessionId,
        createdBy: user.id,
        isLive: Boolean(isLive),
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
    });

    const shareLink = existingLiveLink
      ? await prisma.shareLink.update({
          where: { id: existingLiveLink.id },
          data: { expiresAt },
        })
      : await prisma.shareLink.create({
          data: {
            sessionId,
            createdBy: user.id,
            token: randomBytes(24).toString('base64url'),
            isLive: Boolean(isLive),
            expiresAt,
          },
        });

    const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || new URL(req.url).origin;

    return NextResponse.json(
      {
        id: shareLink.id,
        token: shareLink.token,
        isLive: shareLink.isLive,
        expiresAt: shareLink.expiresAt,
        url: `${appBaseUrl}/session/${sessionId}/view?token=${shareLink.token}`,
      },
      { status: existingLiveLink ? 200 : 201 }
    );
  } catch (error) {
    console.error('Create share link error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const rateLimited = await enforceRateLimit(req, {
    scope: 'share:disable',
    limit: 30,
    windowMs: 60_000,
  });
  if (rateLimited) {
    return rateLimited;
  }

  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const sessionId = sanitizeTextInput(body.sessionId, { maxLength: 64 });
    if (!sessionId) {
      return NextResponse.json(
        { error: 'sessionId is required' },
        { status: 400 }
      );
    }

    let session;
    try {
      session = await getOwnedSession(sessionId, user.id);
    } catch {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    await prisma.shareLink.updateMany({
      where: {
        sessionId,
        createdBy: user.id,
        isLive: true,
      },
      data: {
        isLive: false,
        expiresAt: new Date(),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Disable share link error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
