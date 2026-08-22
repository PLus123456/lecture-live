import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { invalidateShareLinksApiCache } from '@/lib/apiResponseCache';
import { logAction } from '@/lib/auditLog';
import { notifyLiveShareLinksRevoked } from '@/lib/liveShare/revocationNotifier';
import {
  getSecurityAuditRequestId,
  writeSecurityAudit,
} from '@/lib/securityAudit';

class RequiredSecurityAuditError extends Error {
  constructor(readonly auditCause: unknown) {
    super('required security audit write failed', { cause: auditCause });
    this.name = 'RequiredSecurityAuditError';
  }
}

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
  const auditRequestId = getSecurityAuditRequestId(req);

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

    // SEC-033：此响应含完整 bearer token 与分享 URL。必须先确认安全
    // 审计已持久化再返回；审计事件只记录过滤条件的摘要，绝不复制 token/URL。
    try {
      await writeSecurityAudit(req, {
        event: 'share_links.read',
        operator: {
          id: admin.id,
          email: admin.email,
          role: admin.role,
        },
        target: {
          type: 'share_link_collection',
          id: 'all',
        },
        reason: 'admin_list',
        outcome: 'SUCCESS',
        metadata: {
          filters: {
            keywordApplied: keyword.length > 0,
            status: statusFilter || null,
          },
          page,
          pageSize,
          count: payload.length,
          total,
        },
        requestId: auditRequestId,
      });
    } catch (auditErr) {
      console.error('分享链接读取审计写入失败:', auditErr);
      return NextResponse.json({ error: '审计服务不可用' }, { status: 503 });
    }

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

  const auditRequestId = getSecurityAuditRequestId(req);
  let requestedIds: string[] = [];
  let safeTargets: Array<{ id: string; sessionId: string; ownerId: string }> = [];
  let deletionCompleted = false;
  let deletedCount = 0;
  let failureStage = 'load_targets';

  try {
    const body = await req.json().catch(() => ({}));
    const rawIds: unknown[] = Array.isArray(body.ids) ? body.ids : [];
    requestedIds = [
      ...new Set(
        rawIds.filter((x: unknown): x is string => typeof x === 'string'),
      ),
    ];

    if (requestedIds.length === 0) {
      return NextResponse.json({ error: '请提供要删除的分享链接 ID' }, { status: 400 });
    }

    const targets = await prisma.shareLink.findMany({
      where: { id: { in: requestedIds } },
      select: { id: true, sessionId: true, createdBy: true },
    });

    // 结构化审计快照只用脱敏字段；删除流程也无需读取 bearer token。
    safeTargets = targets.map((target) => ({
      id: target.id,
      sessionId: target.sessionId,
      ownerId: target.createdBy,
    }));

    // 只有 ATTEMPTED 已持久化后，才允许执行 deleteMany 以及后续缓存/WS 副作用。
    try {
      await writeSecurityAudit(req, {
        event: 'share_links.delete',
        operator: {
          id: admin.id,
          email: admin.email,
          role: admin.role,
        },
        target: {
          type: 'share_link',
          // 只记录 DB 已确认的链接 ID；原始 ids 可能被恶意填入 bearer token。
          ids: safeTargets.map((target) => target.id),
          ownerId:
            new Set(safeTargets.map((target) => target.ownerId)).size === 1
              ? safeTargets[0]?.ownerId
              : undefined,
        },
        before: {
          count: safeTargets.length,
          items: safeTargets,
        },
        reason: 'admin_delete',
        outcome: 'ATTEMPTED',
        metadata: {
          requestedCount: requestedIds.length,
        },
        requestId: auditRequestId,
      });
    } catch (auditErr) {
      console.error('分享链接删除尝试审计写入失败:', auditErr);
      return NextResponse.json({ error: '审计服务不可用' }, { status: 503 });
    }

    failureStage = 'delete_database';
    const result = await prisma.$transaction(async (tx) => {
      const deleted = await tx.shareLink.deleteMany({
        where: { id: { in: requestedIds } },
      });
      try {
        await writeSecurityAudit(
          req,
          {
            event: 'share_links.delete',
            operator: {
              id: admin.id,
              email: admin.email,
              role: admin.role,
            },
            target: {
              type: 'share_link',
              ids: safeTargets.map((target) => target.id),
              ownerId:
                new Set(safeTargets.map((target) => target.ownerId)).size === 1
                  ? safeTargets[0]?.ownerId
                  : undefined,
            },
            before: { count: safeTargets.length, items: safeTargets },
            after: { deleted: deleted.count },
            reason: 'admin_delete',
            outcome: 'SUCCESS',
            metadata: {
              requestedCount: requestedIds.length,
              matchedCount: targets.length,
              phase: 'database',
            },
            requestId: auditRequestId,
          },
          tx
        );
      } catch (auditCause) {
        throw new RequiredSecurityAuditError(auditCause);
      }
      return deleted;
    });
    deletionCompleted = true;
    deletedCount = result.count;

    // 失效缓存：所有受影响的创建者
    const creatorIds = [...new Set(targets.map((t) => t.createdBy))];
    failureStage = 'invalidate_cache';
    await Promise.all(creatorIds.map((id) => invalidateShareLinksApiCache(id)));

    // SHARE-REVOKE-001：硬删链接同样要即时驱逐已连接的 WS 观众（按 DB 复核，
    // 同 session 下未被删除的其他有效链接的观众不受影响）。
    const affectedSessionIds = [...new Set(targets.map((t) => t.sessionId))];
    failureStage = 'revoke_viewers';
    await Promise.all(
      affectedSessionIds.map((sessionId) =>
        notifyLiveShareLinksRevoked(sessionId, 'revoke')
      )
    );

    const outcome =
      result.count === requestedIds.length && targets.length === requestedIds.length
        ? 'SUCCESS'
        : 'PARTIAL';

    try {
      await writeSecurityAudit(req, {
        event: 'share_links.delete',
        operator: {
          id: admin.id,
          email: admin.email,
          role: admin.role,
        },
        target: {
          type: 'share_link',
          ids: safeTargets.map((target) => target.id),
          ownerId:
            new Set(safeTargets.map((target) => target.ownerId)).size === 1
              ? safeTargets[0]?.ownerId
              : undefined,
        },
        before: {
          count: safeTargets.length,
          items: safeTargets,
        },
        after: {
          deleted: result.count,
          missing: Math.max(0, requestedIds.length - result.count),
        },
        reason: 'admin_delete',
        outcome,
        metadata: {
          requestedCount: requestedIds.length,
          matchedCount: targets.length,
        },
        requestId: auditRequestId,
      });
    } catch (auditErr) {
      console.error('分享链接删除结果审计写入失败:', auditErr);
      return NextResponse.json({ error: '审计服务不可用' }, { status: 503 });
    }

    logAction(req, 'admin.share.delete', {
      user: admin,
      detail: `删除 ${result.count} 个分享链接 (ids: ${targets.map((t) => t.id.slice(0, 8)).join(', ')})`,
    });

    return NextResponse.json({ deleted: result.count });
  } catch (err) {
    console.error('删除分享链接失败:', err);
    const requiredAuditUnavailable = err instanceof RequiredSecurityAuditError;
    if (requestedIds.length > 0) {
      try {
        await writeSecurityAudit(req, {
          event: 'share_links.delete',
          operator: {
            id: admin.id,
            email: admin.email,
            role: admin.role,
          },
          target: {
            type: 'share_link',
            ids: safeTargets.map((target) => target.id),
            ownerId:
              new Set(safeTargets.map((target) => target.ownerId)).size === 1
                ? safeTargets[0]?.ownerId
                : undefined,
          },
          before: {
            count: safeTargets.length,
            items: safeTargets,
          },
          after: {
            deleted: deletedCount,
          },
          reason: 'admin_delete',
          outcome: deletionCompleted ? 'PARTIAL' : 'FAILED',
          metadata: {
            stage: failureStage,
          },
          requestId: auditRequestId,
        });
      } catch (auditErr) {
        console.error('分享链接删除失败审计写入失败:', auditErr);
        return NextResponse.json({ error: '审计服务不可用' }, { status: 503 });
      }
    }
    if (requiredAuditUnavailable) {
      return NextResponse.json({ error: '审计服务不可用' }, { status: 503 });
    }
    return NextResponse.json({ error: '删除失败' }, { status: 500 });
  }
}
