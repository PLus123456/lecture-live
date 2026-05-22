import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { prisma } from '@/lib/prisma';
import {
  validateChatFileCleanupParams,
  olderThanDaysToCutoff,
  performChatFileCleanup,
} from '@/lib/chatFileCleanup';

/**
 * Admin Chat Files API（GET 列表 / 预览；DELETE 是 CleanupModalShell 走的
 * "query string + DELETE" 通道；批量清理另有 POST /api/admin/chat-files/cleanup
 * 走 JSON body，两种入口背后都调同一个清理函数 — 见 chatFileCleanup.ts）。
 *
 * **重要：本端点只删 DB 行 + 释放配额，不动 Cloudreve 物理文件。** Cloudreve
 * 上的残留由 U14 cron `chat_files_cleanup` 顺手收掉（admin 操作以"释放配额给
 * 用户"为首要目标，物理回收可以延后到 cron）。
 */

interface ChatFileRow {
  id: string;
  conversationId: string;
  userId: string;
  kind: string;
  fileName: string;
  mimeType: string;
  bytes: bigint;
  createdAt: Date;
  lastAccessedAt: Date;
}

interface UserRef {
  id: string;
  email: string;
  displayName: string;
}

// bytes 在 JSON 化时必须是 Number — BigInt 不能直接序列化。我们的 bytes 上限
// 远小于 Number.MAX_SAFE_INTEGER (~9 PB)，安全。
function bytesToNumber(b: bigint): number {
  return Number(b);
}

function buildListWhere(params: {
  userId?: string;
  kind?: string;
  conversationId?: string;
  olderThanDays?: number;
}): Prisma.ChatAttachmentWhereInput {
  const where: Prisma.ChatAttachmentWhereInput = {};
  if (params.userId) where.userId = params.userId;
  if (params.conversationId) where.conversationId = params.conversationId;
  if (params.kind) where.kind = params.kind;
  if (params.olderThanDays && params.olderThanDays > 0) {
    where.createdAt = { lt: olderThanDaysToCutoff(params.olderThanDays) };
  }
  return where;
}

// ─── GET: 列表 / 预览计数 ─────────────────────────────────────
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  // ── 清理预览（CleanupModalShell 约定：?cleanup_preview=1）──
  if (searchParams.get('cleanup_preview') === '1') {
    const { response } = await requireAdminAccess(req, {
      scope: 'admin:chat-files:cleanup:preview',
      limit: 30,
      windowMs: 60_000,
    });
    if (response) return response;

    const validation = validateChatFileCleanupParams({
      olderThanDays: Number(searchParams.get('olderThanDays')),
      sizeBytesGT: Number(searchParams.get('sizeBytesGT') ?? 0),
      userId: searchParams.get('userId') || undefined,
      kinds: searchParams.getAll('kinds'),
      conversationId: searchParams.get('conversationId') || undefined,
    });
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    try {
      const cutoff = olderThanDaysToCutoff(validation.olderThanDays);
      const count = await prisma.chatAttachment.count({
        where: {
          createdAt: { lt: cutoff },
          ...(validation.userId ? { userId: validation.userId } : {}),
          ...(validation.kinds.length > 0
            ? { kind: { in: validation.kinds } }
            : {}),
          ...(validation.conversationId
            ? { conversationId: validation.conversationId }
            : {}),
          ...(validation.sizeBytesGT > 0
            ? { bytes: { gt: BigInt(validation.sizeBytesGT) } }
            : {}),
        },
      });
      return NextResponse.json({ count });
    } catch (err) {
      console.error('chat-files cleanup preview failed:', err);
      return NextResponse.json({ error: '查询失败' }, { status: 500 });
    }
  }

  // ── 列表 ──
  const { response } = await requireAdminAccess(req, {
    scope: 'admin:chat-files:list',
    limit: 60,
  });
  if (response) return response;

  const userId = searchParams.get('userId') || undefined;
  const kind = searchParams.get('kind') || undefined;
  const conversationId = searchParams.get('conversationId') || undefined;
  const olderThanDaysRaw = Number(searchParams.get('olderThanDays') ?? 0);
  const olderThanDays =
    Number.isInteger(olderThanDaysRaw) && olderThanDaysRaw > 0
      ? olderThanDaysRaw
      : undefined;
  const limit = Math.min(
    100,
    Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10) || 50)
  );
  const cursor = searchParams.get('cursor') || undefined;

  try {
    const where = buildListWhere({ userId, kind, conversationId, olderThanDays });

    // cursor 基于 id（createdAt 可能不唯一，prisma 用 id tiebreaker）。
    // +1 多取一条用来判断 hasMore。
    const rows = await prisma.chatAttachment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items: ChatFileRow[] = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;

    // 一次性把涉及的 userId 拉出来，避免 N+1。
    const userIds = Array.from(new Set(items.map((r) => r.userId)));
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, displayName: true },
        })
      : [];
    const userById = new Map<string, UserRef>(users.map((u) => [u.id, u]));

    return NextResponse.json({
      items: items.map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        userId: row.userId,
        userEmail: userById.get(row.userId)?.email ?? null,
        userDisplayName: userById.get(row.userId)?.displayName ?? null,
        kind: row.kind,
        fileName: row.fileName,
        mimeType: row.mimeType,
        bytes: bytesToNumber(row.bytes),
        createdAt: row.createdAt.toISOString(),
        lastAccessedAt: row.lastAccessedAt.toISOString(),
      })),
      nextCursor,
      hasMore,
    });
  } catch (err) {
    console.error('chat-files list failed:', err);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}

// ─── DELETE: CleanupModalShell 走 querystring + DELETE 这一通道 ──────
export async function DELETE(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:chat-files:cleanup',
    limit: 10,
    windowMs: 60_000,
  });
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const validation = validateChatFileCleanupParams({
    olderThanDays: Number(searchParams.get('olderThanDays')),
    sizeBytesGT: Number(searchParams.get('sizeBytesGT') ?? 0),
    userId: searchParams.get('userId') || undefined,
    kinds: searchParams.getAll('kinds'),
    conversationId: searchParams.get('conversationId') || undefined,
  });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const result = await performChatFileCleanup({
      olderThanDays: validation.olderThanDays,
      sizeBytesGT: validation.sizeBytesGT,
      userId: validation.userId,
      kinds: validation.kinds,
      conversationId: validation.conversationId,
    });

    logAction(req, 'admin.chat_files.cleanup', {
      user: admin,
      detail: JSON.stringify({
        olderThanDays: validation.olderThanDays,
        sizeBytesGT: validation.sizeBytesGT,
        userId: validation.userId,
        kinds: validation.kinds,
        conversationId: validation.conversationId,
        deletedCount: result.deleted,
        releasedBytes: result.releasedBytes,
        truncated: result.truncated,
      }),
    });

    return NextResponse.json({
      success: true,
      // CleanupModalShell 读 deletedCount。
      deletedCount: result.deleted,
      deleted: result.deleted,
      releasedBytes: result.releasedBytes,
      truncated: result.truncated,
    });
  } catch (err) {
    console.error('chat-files cleanup (DELETE) failed:', err);
    return NextResponse.json({ error: '清理失败' }, { status: 500 });
  }
}
