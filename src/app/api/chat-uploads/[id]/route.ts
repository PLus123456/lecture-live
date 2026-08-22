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
      conversation: { select: { endedAt: true } },
    },
  });
  if (!attachment) {
    return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });
  }

  // owner 或 ADMIN 可删
  if (attachment.userId !== user.id && user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  // 已关闭（endedAt 非空）的对话是只读的：不允许删除其附件（会真实删 Cloudreve 文件 +
  // DB 行，破坏只读语义）。UI 也已隐藏删除入口，这里做服务端兜底（含直接打 API 的情况）。
  if (attachment.conversation?.endedAt) {
    return NextResponse.json(
      { error: 'Conversation is closed (read-only)' },
      { status: 409 }
    );
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
  //
  // L62：这里刻意用 deleteMany + count 而不是 delete。两个并发 DELETE 打同一个 id 时，
  // 双方都能通过上面的 findUnique 检查、都会走到这一步；`prisma.delete` 对已被对方删掉的
  // 行抛 P2025，旧代码把它当 DB 故障回 500 —— 用户看到「删除失败」而文件其实已经删干净了
  // （前端 removeAttachment 还会因此回滚 chip 并 toast 报错）。
  //
  // 更要紧的是配额：count 是「本请求真的删掉了几行」的权威口径。只有 count===1 才释放字节，
  // 与 chatFileCleanup 的 B8 / conversationCascade 的 P5-13 同一条不变量 ——
  // 任一行的字节至多被释放一次，杜绝并发双删各退一份的凭空配额。
  let deletedCount: number;
  try {
    const result = await prisma.chatAttachment.deleteMany({ where: { id } });
    deletedCount = result.count;
  } catch (err) {
    routeLogger.error(
      { id, err: serializeError(err) },
      'chat-uploads-delete: DB delete failed'
    );
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }

  if (deletedCount === 0) {
    // 并发的另一路已经删掉了这一行（并已释放过它的字节）。删除语义上已达成，
    // 回 200 保持幂等；**绝不能**在这里 releaseStorageBytes，那就是重复退额度。
    routeLogger.info(
      { id },
      'chat-uploads-delete: 行已被并发请求删除；跳过配额释放（幂等返回）'
    );
    return NextResponse.json({ ok: true, alreadyDeleted: true });
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
