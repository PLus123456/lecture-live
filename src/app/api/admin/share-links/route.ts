import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { invalidateShareLinksApiCache } from '@/lib/apiResponseCache';
import { logAction } from '@/lib/auditLog';
import { notifyLiveShareLinksRevoked } from '@/lib/liveShare/revocationNotifier';

// 管理员：获取全站分享链接列表（分页 + 过滤）
export async function GET(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:share-links:list',
    limit: 60,
  });
  if (response) {
    return response;
  }
  if (!admin) {
    return NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));
  const keyword = (searchParams.get('keyword') || '').trim();
  const statusFilter = searchParams.get('status') || ''; // 'live' | 'playback' | 'expired' | ''

  try {
    const where: Record<string, unknown> = {};
    const now = new Date();

    if (statusFilter === 'live') {
      where.isLive = true;
      where.OR = [{ expiresAt: null }, { expiresAt: { gt: now } }];
    } else if (statusFilter === 'playback') {
      where.isLive = false;
      where.OR = [{ expiresAt: null }, { expiresAt: { gt: now } }];
    } else if (statusFilter === 'expired') {
      where.expiresAt = { lte: now };
    }

    // 关键词：匹配 session 标题或创建者邮箱/名字
    if (keyword) {
      const keywordOr = [
        { session: { title: { contains: keyword } } },
        { creator: { email: { contains: keyword } } },
        { creator: { displayName: { contains: keyword } } },
        { token: { contains: keyword } },
      ];
      if (where.OR) {
        // 合并已有 OR：用 AND 包裹
        const existingOr = where.OR;
        delete where.OR;
        where.AND = [{ OR: existingOr }, { OR: keywordOr }];
      } else {
        where.OR = keywordOr;
      }
    }

    const [links, total] = await Promise.all([
      prisma.shareLink.findMany({
        where,
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
          creator: {
            select: {
              id: true,
              email: true,
              displayName: true,
              role: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.shareLink.count({ where }),
    ]);

    const appBaseUrl =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ||
      new URL(req.url).origin;

    const payload = links.map((link) => ({
      id: link.id,
      token: link.token,
      sessionId: link.sessionId,
      isLive: link.isLive,
      expiresAt: link.expiresAt,
      createdAt: link.createdAt,
      url: `${appBaseUrl}/session/${link.sessionId}/view?token=${link.token}`,
      session: link.session,
      creator: link.creator,
    }));

    return NextResponse.json({
      links: payload,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    console.error('查询分享链接失败:', err);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}

// 管理员：删除分享链接（单个或批量）
export async function DELETE(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:share-links:delete',
    limit: 30,
    windowMs: 60_000,
  });
  if (response) {
    return response;
  }
  if (!admin) {
    return NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body.ids)
      ? body.ids.filter((x: unknown): x is string => typeof x === 'string')
      : [];

    if (ids.length === 0) {
      return NextResponse.json({ error: '请提供要删除的分享链接 ID' }, { status: 400 });
    }

    const targets = await prisma.shareLink.findMany({
      where: { id: { in: ids } },
      select: { id: true, sessionId: true, createdBy: true, token: true },
    });

    const result = await prisma.shareLink.deleteMany({
      where: { id: { in: ids } },
    });

    // 失效缓存：所有受影响的创建者
    const creatorIds = [...new Set(targets.map((t) => t.createdBy))];
    await Promise.all(creatorIds.map((id) => invalidateShareLinksApiCache(id)));

    // SHARE-REVOKE-001：硬删链接同样要即时驱逐已连接的 WS 观众（按 DB 复核，
    // 同 session 下未被删除的其他有效链接的观众不受影响）。
    const affectedSessionIds = [...new Set(targets.map((t) => t.sessionId))];
    await Promise.all(
      affectedSessionIds.map((sessionId) =>
        notifyLiveShareLinksRevoked(sessionId, 'revoke')
      )
    );

    logAction(req, 'admin.share.delete', {
      user: admin,
      detail: `删除 ${result.count} 个分享链接 (ids: ${targets.map((t) => t.id.slice(0, 8)).join(', ')})`,
    });

    return NextResponse.json({ deleted: result.count });
  } catch (err) {
    console.error('删除分享链接失败:', err);
    return NextResponse.json({ error: '删除失败' }, { status: 500 });
  }
}
