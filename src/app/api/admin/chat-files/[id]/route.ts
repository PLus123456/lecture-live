import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { prisma } from '@/lib/prisma';
import { releaseUserStorageBytesRaw } from '@/lib/chatFileCleanup';

/**
 * DELETE /api/admin/chat-files/[id] — 单条删除。
 *
 * 与批量清理走同一套半逻辑：raw SQL clamp 释放配额 + 删 DB 行；不会动
 * Cloudreve 上的物理文件（U14 cron 负责）。删除不存在的 id 返回 404。
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:chat-files:delete',
    limit: 30,
    windowMs: 60_000,
  });
  if (response) return response;

  const { id } = await params;
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: '缺少附件 ID' }, { status: 400 });
  }

  try {
    const row = await prisma.chatAttachment.findUnique({
      where: { id },
      select: { id: true, userId: true, bytes: true, fileName: true },
    });
    if (!row) {
      return NextResponse.json({ error: '附件不存在' }, { status: 404 });
    }

    await prisma.$transaction(async (tx) => {
      await releaseUserStorageBytesRaw(tx, row.userId, row.bytes);
      await tx.chatAttachment.delete({ where: { id } });
    });

    logAction(req, 'admin.chat_files.delete', {
      user: admin,
      detail: JSON.stringify({
        id,
        userId: row.userId,
        fileName: row.fileName,
        releasedBytes: Number(row.bytes),
      }),
    });

    return NextResponse.json({
      success: true,
      deleted: 1,
      releasedBytes: Number(row.bytes),
    });
  } catch (err) {
    console.error('chat-files single delete failed:', err);
    return NextResponse.json({ error: '删除失败' }, { status: 500 });
  }
}
