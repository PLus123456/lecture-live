/**
 * 取消进行中的 async 上传/转录。
 *
 * 状态语义：把 session 标为 canceled、清本地 chunks/merged/mp3、删 Soniox 上的文件。
 * 已经在 ffmpeg 阶段或 Soniox 上传阶段的不会被立即中断（后台 promise 仍在跑），
 * 但完成后会发现 status 已变成 canceled，自然退出。
 *
 * 注意：这是终态，调用后 session 不能再"恢复转录"。如果只是想关 modal 让任务在
 * 后台跑，前端走 minimize 路径而不是 cancel。
 */
import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership } from '@/lib/security';
import { enforceRateLimit } from '@/lib/rateLimit';
import { cancelAsyncUpload } from '@/lib/audio/asyncUploadProcessor';

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceRateLimit(req, {
    scope: 'sessions:async-upload-cancel',
    limit: 60,
    windowMs: 60 * 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) return rateLimited;

  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  try {
    assertOwnership(user.id, session.userId);
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  // 已完成 / 已失败 / 已取消 —— 幂等返回
  if (
    session.asyncTranscribeStatus === 'completed' ||
    session.asyncTranscribeStatus === 'failed' ||
    session.asyncTranscribeStatus === 'canceled' ||
    session.asyncTranscribeStatus == null
  ) {
    return NextResponse.json({ success: true, status: session.asyncTranscribeStatus });
  }

  await cancelAsyncUpload(session);

  return NextResponse.json({ success: true, status: 'canceled' });
}
