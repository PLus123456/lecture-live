// DELETE /api/chat-uploads/[id]
//
// 删除一条 ChatAttachment：
//   1. 校验归属（owner 或 ADMIN）
//   2. 物理文件 best-effort 删（cloudrevePath + extractedTextPath；失败仅 log）
//   3. 删 DB 行
//   4. releaseStorageBytes 释放配额
//
// Cloudreve 物理删除走 @/lib/storage/cloudreveFileDelete 的统一实现（与删对话 / cron /
// 删用户共用同一份），失败不抛 —— 物理残留可由 cron 兜底。

import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { releaseStorageBytes } from '@/lib/quota';
import {
  loadCloudreveContext,
  deleteCloudreveFile,
} from '@/lib/storage/cloudreveFileDelete';
import { logger, serializeError } from '@/lib/logger';

const routeLogger = logger.child({ component: 'chat-uploads-delete' });

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Invalid attachment id' }, { status: 400 });
  }

  const attachment = await prisma.chatAttachment.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      bytes: true,
      cloudrevePath: true,
      extractedTextPath: true,
    },
  });
  if (!attachment) {
    return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });
  }

  // owner 或 ADMIN 可删
  if (attachment.userId !== user.id && user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  // 物理文件 best-effort 删除（失败不阻塞 DB 清理）
  const cloudreveCtx = await loadCloudreveContext();
  if (cloudreveCtx) {
    await deleteCloudreveFile(attachment.cloudrevePath, cloudreveCtx);
    if (attachment.extractedTextPath) {
      await deleteCloudreveFile(attachment.extractedTextPath, cloudreveCtx);
    }
  }

  // DB 删除 + 配额释放（按附件 owner 释放，admin 跨用户删也要还给原用户）
  try {
    await prisma.chatAttachment.delete({ where: { id } });
  } catch (err) {
    routeLogger.error(
      { id, err: serializeError(err) },
      'chat-uploads-delete: DB delete failed'
    );
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }

  try {
    await releaseStorageBytes(attachment.userId, Number(attachment.bytes));
  } catch (err) {
    routeLogger.warn(
      {
        userId: attachment.userId,
        bytes: attachment.bytes.toString(),
        err: serializeError(err),
      },
      'chat-uploads-delete: releaseStorageBytes failed; admin reconcile 会兜底'
    );
  }

  return NextResponse.json({ ok: true });
}
