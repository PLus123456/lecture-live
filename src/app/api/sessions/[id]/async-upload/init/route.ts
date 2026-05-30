/**
 * 初始化文件分片上传会话。前端在拿到 sessionId 后、开始上传 chunks 前调用一次。
 *
 * 写入 manifest 元数据：原始文件名 / MIME / 总大小 / 分片数 / 分片大小。
 * 同时把 session.asyncTranscribeStatus 置为 'uploading_chunks'，标记走 async 路径。
 */
import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership, parsePositiveInteger, sanitizeTextInput } from '@/lib/security';
import { enforceRateLimit } from '@/lib/rateLimit';
import { checkQuota } from '@/lib/quota';
import { initAsyncUpload } from '@/lib/audio/asyncUploadChunkPersistence';

// 单文件总大小上限：5 GB（足以覆盖 5 小时 1080p mp4）
const MAX_TOTAL_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_CHUNK_BYTES = 20 * 1024 * 1024;
const MIN_CHUNK_BYTES = 64 * 1024;
const ACCEPTED_MEDIA_RE = /^(audio|video)\//i;

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
    scope: 'sessions:async-upload-init',
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

  // 异步上传转录要计费（批2）：入口先挡配额耗尽，避免上传/转码后才发现扣不了费。
  // 注意这里只做"是否还有余量"的前置拦截；实际扣减在转录完成时按 ceil(分钟)×倍率 进行。
  const quotaOk = await checkQuota(user.id, 'transcription_minutes');
  if (!quotaOk) {
    return NextResponse.json({ error: 'Quota exceeded' }, { status: 403 });
  }

  let body: {
    originalFileName?: unknown;
    originalMimeType?: unknown;
    originalSize?: unknown;
    totalChunks?: unknown;
    chunkSize?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const originalFileName = sanitizeTextInput(String(body.originalFileName ?? ''), {
    maxLength: 255,
    fallback: 'upload.bin',
  });
  const originalMimeType = sanitizeTextInput(String(body.originalMimeType ?? ''), {
    maxLength: 128,
    fallback: 'application/octet-stream',
  });
  if (!ACCEPTED_MEDIA_RE.test(originalMimeType)) {
    return NextResponse.json(
      { error: 'Only audio/* and video/* MIME types are accepted' },
      { status: 400 }
    );
  }

  let originalSize: number;
  let totalChunks: number;
  let chunkSize: number;
  try {
    originalSize = parsePositiveInteger(body.originalSize, {
      min: 1,
      max: MAX_TOTAL_UPLOAD_BYTES,
    });
    chunkSize = parsePositiveInteger(body.chunkSize, {
      min: MIN_CHUNK_BYTES,
      max: MAX_CHUNK_BYTES,
    });
    totalChunks = parsePositiveInteger(body.totalChunks, {
      min: 1,
      max: 100_000,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid integer input' },
      { status: 400 }
    );
  }

  // 校验分片数学：totalChunks * chunkSize >= originalSize（最后一片可能不满）
  const minTotal = (totalChunks - 1) * chunkSize + 1;
  const maxTotal = totalChunks * chunkSize;
  if (originalSize < minTotal || originalSize > maxTotal) {
    return NextResponse.json(
      { error: 'totalChunks * chunkSize does not match originalSize' },
      { status: 400 }
    );
  }

  try {
    const manifest = await initAsyncUpload(session, {
      originalFileName,
      originalMimeType,
      originalSize,
      totalChunks,
      chunkSize,
    });

    await prisma.session.update({
      where: { id },
      data: {
        asyncTranscribeStatus: 'uploading_chunks',
        asyncTranscribeError: null,
        asyncTranscribeStartedAt: new Date(),
      },
    });

    return NextResponse.json({
      success: true,
      manifest: {
        totalChunks: manifest.totalChunks,
        chunkSize: manifest.chunkSize,
        receivedSeqs: manifest.receivedSeqs,
      },
    });
  } catch (error) {
    console.error('Async upload init error:', error);
    return NextResponse.json(
      { error: 'Failed to initialize async upload' },
      { status: 500 }
    );
  }
}
