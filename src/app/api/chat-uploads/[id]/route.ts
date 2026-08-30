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
import {
  loadCloudreveContext,
  deleteCloudreveFile,
} from '@/lib/storage/cloudreveFileDelete';
import { logger, serializeError } from '@/lib/logger';
import {
  STORED_ARTIFACT_TYPE,
  areStoredArtifactDeleteIntentsDurable,
  assertStoredArtifactBackfillComplete,
  assertStoredArtifactReferencesCovered,
  findBillableStoredArtifactsByOwner,
  markStoredArtifactsDeletePendingInTransaction,
  releaseStoredArtifact,
} from '@/lib/storage/storedArtifactLedger';

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

  let ledgerRows: Awaited<
    ReturnType<typeof findBillableStoredArtifactsByOwner>
  >;
  try {
    await assertStoredArtifactBackfillComplete();
    ledgerRows = await findBillableStoredArtifactsByOwner(
      'chat_attachment',
      attachment.id
    );
    assertStoredArtifactReferencesCovered(ledgerRows, [
      attachment.cloudrevePath,
      attachment.extractedTextPath,
    ]);
  } catch (err) {
    routeLogger.error(
      { id, err: serializeError(err) },
      'chat attachment inventory is incomplete; delete refused'
    );
    return NextResponse.json(
      { error: 'Attachment storage inventory is not ready' },
      { status: 503, headers: { 'Retry-After': '30' } }
    );
  }

  // 先在同一 DB 事务中删 owner 并把 ledger 变成持久 DELETE_PENDING。
  // 物理删除放在提交后：崩溃只会留下可重试的 ownerless 对象，
  // 绝不会把仍可见的附件先删成断链。
  try {
    await prisma.$transaction(async (tx) => {
      await markStoredArtifactsDeletePendingInTransaction(
        tx,
        ledgerRows.map((row) => row.id)
      );
      await tx.chatAttachment.delete({ where: { id } });
      if (ledgerRows.length === 0) {
        await tx.$executeRaw`
          UPDATE User
          SET storageBytesUsed = GREATEST(0, storageBytesUsed - ${attachment.bytes})
          WHERE id = ${attachment.userId}
        `;
      }
    });
  } catch (err) {
    try {
      const owner = await prisma.chatAttachment.findUnique({
        where: { id },
        select: { id: true },
      });
      if (owner) {
        routeLogger.error(
          { id, err: serializeError(err) },
          'chat-uploads-delete: DB delete failed'
        );
        return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
      }
      const deleteIntentDurable = await areStoredArtifactDeleteIntentsDurable(
        ledgerRows.map((row) => row.id)
      );
      if (!deleteIntentDurable) {
        routeLogger.error(
          { id },
          'chat attachment owner detached without a provable ledger delete intent'
        );
        return NextResponse.json(
          { error: 'Delete status is being reconciled' },
          { status: 503, headers: { 'Retry-After': '30' } }
        );
      }
      routeLogger.warn(
        { id },
        'chat attachment delete returned failure but owner+ledger readback confirmed commit'
      );
    } catch (readbackError) {
      routeLogger.error(
        { id, err: serializeError(readbackError) },
        'chat attachment delete outcome unknown; physical files preserved'
      );
      return NextResponse.json(
        { error: 'Delete status is being reconciled' },
        { status: 503, headers: { 'Retry-After': '30' } }
      );
    }
  }

  const cloudreveCtx = await loadCloudreveContext();
  let rawDeleted = false;
  let extractedDeleted = attachment.extractedTextPath === null;
  if (cloudreveCtx) {
    rawDeleted = await deleteCloudreveFile(
      attachment.cloudrevePath,
      cloudreveCtx
    );
    if (attachment.extractedTextPath) {
      extractedDeleted = await deleteCloudreveFile(
        attachment.extractedTextPath,
        cloudreveCtx
      );
    }
  }

  if (ledgerRows.length > 0) {
    for (const artifact of ledgerRows) {
      const deleted =
        artifact.artifactType === STORED_ARTIFACT_TYPE.CHAT_EXTRACTED
          ? extractedDeleted
          : rawDeleted;
      if (deleted) {
        await releaseStoredArtifact(artifact.id).catch(() => undefined);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
