/**
 * 触发后台处理：合并分片 → ffmpeg 转码 → 上传 Soniox → 创建 transcription。
 * 立即返回，前端通过 /async-transcribe-status 轮询进度。
 */
import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership } from '@/lib/security';
import { enforceRateLimit } from '@/lib/rateLimit';
import { loadAsyncUploadManifest } from '@/lib/audio/asyncUploadChunkPersistence';
import { startAsyncUploadProcessing } from '@/lib/audio/asyncUploadProcessor';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceRateLimit(req, {
    scope: 'sessions:async-upload-finalize',
    limit: 30,
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

  if (session.asyncTranscribeStatus !== 'uploading_chunks') {
    return NextResponse.json(
      {
        error: `Cannot finalize: current status is ${session.asyncTranscribeStatus ?? 'null'}`,
      },
      { status: 409 }
    );
  }

  const manifest = await loadAsyncUploadManifest(session);
  if (!manifest) {
    return NextResponse.json({ error: 'Upload not initialized' }, { status: 400 });
  }
  if (manifest.receivedSeqs.length !== manifest.totalChunks) {
    return NextResponse.json(
      {
        error: `Missing chunks: ${manifest.receivedSeqs.length} of ${manifest.totalChunks}`,
        receivedSeqs: manifest.receivedSeqs,
      },
      { status: 400 }
    );
  }

  // 原子 claim：uploading_chunks → transcoding，只有抢到的那次才真正启动后台 pipeline。
  // 上面的状态检查与这里之间存在 TOCTOU 窗口，两个并发 finalize 都可能通过检查；
  // 用 updateMany 的条件更新把"启动权"收敛到一次，避免重复转码 / 重复上传 Soniox /
  // 重复扣 Soniox 配额。processor 首步的 setStatus('transcoding') 对此幂等。
  const claimed = await prisma.session.updateMany({
    where: { id: session.id, asyncTranscribeStatus: 'uploading_chunks' },
    data: { asyncTranscribeStatus: 'transcoding', asyncTranscribeStartedAt: new Date() },
  });
  if (claimed.count !== 1) {
    // 另一个并发请求已抢先启动 —— 幂等返回，不再重复启动
    return NextResponse.json({ success: true, status: 'already_processing' });
  }

  // Kick off background processing —— 不 await，立即返回。
  startAsyncUploadProcessing({ sessionId: session.id });

  return NextResponse.json({
    success: true,
    status: 'processing_started',
  });
}
