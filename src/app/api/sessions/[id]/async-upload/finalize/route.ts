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

  // Kick off background processing —— 不 await，立即返回。
  startAsyncUploadProcessing({ sessionId: session.id });

  return NextResponse.json({
    success: true,
    status: 'processing_started',
  });
}
