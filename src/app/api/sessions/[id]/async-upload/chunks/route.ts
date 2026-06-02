/**
 * 接收单个分片（FormData：file + seq）。前端按 20MB/片切，分片之间可以并发上传。
 *
 * 不在这里做内容嗅探 —— ffmpeg 在 finalize 时会自己检测格式，错误会直接抛。
 * 这里只校验大小 + 调用方对 session 的权限。
 */
import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership, parsePositiveInteger } from '@/lib/security';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  loadAsyncUploadManifest,
  persistAsyncUploadChunk,
} from '@/lib/audio/asyncUploadChunkPersistence';

const MAX_CHUNK_BYTES = 20 * 1024 * 1024;

// Next.js 默认 Route Handler 有 body size 限制（约 1MB），需要拉到 20MB+。
// 用 segment config 单独配置这个路由。
export const config = {
  api: {
    bodyParser: false,
  },
};

// Next 15 App Router 用 export const runtime 控制运行时；保持默认 node。
// 默认的 body size limit 在 Route Handler 里实际上由 `await req.formData()` 处理，
// formData() 内部限制依 Next 版本而异。Next 15 默认是 1GB（NextRequest）— 够用。

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 每片一个请求，N 片合并下来 rate limit 要给宽松些
  const rateLimited = await enforceRateLimit(req, {
    scope: 'sessions:async-upload-chunk',
    limit: 2000,
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
      { error: 'Upload session not in uploading state' },
      { status: 409 }
    );
  }

  const manifest = await loadAsyncUploadManifest(session);
  if (!manifest) {
    return NextResponse.json(
      { error: 'Upload not initialized — call /init first' },
      { status: 400 }
    );
  }

  // Content-Length 预检：读 body 前先按声明长度挡掉明显超限的请求，避免把超大 body
  // 整个缓冲进内存才发现超限（OOM 面）。multipart 有额外开销，给 1MB 余量避免误杀；
  // 精确的 file.size 校验仍在下方兜底。
  const declaredLength = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CHUNK_BYTES + 1024 * 1024) {
    return NextResponse.json(
      { error: `Chunk size must be between 1 byte and ${MAX_CHUNK_BYTES} bytes` },
      { status: 413 }
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid multipart body' }, { status: 400 });
  }

  const file = formData.get('file');
  const seqInput = formData.get('seq');

  if (!(file instanceof File) || typeof seqInput !== 'string') {
    return NextResponse.json(
      { error: 'file and seq are required' },
      { status: 400 }
    );
  }

  let seq: number;
  try {
    seq = parsePositiveInteger(seqInput, {
      min: 0,
      max: Math.max(0, manifest.totalChunks - 1),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid seq' },
      { status: 400 }
    );
  }

  // 校验大小：非末片必须 = chunkSize；末片可以更小但不能超过 MAX_CHUNK_BYTES
  const isLastChunk = seq === manifest.totalChunks - 1;
  if (file.size <= 0 || file.size > MAX_CHUNK_BYTES) {
    return NextResponse.json(
      { error: `Chunk size must be between 1 byte and ${MAX_CHUNK_BYTES} bytes` },
      { status: 400 }
    );
  }
  if (!isLastChunk && file.size !== manifest.chunkSize) {
    return NextResponse.json(
      { error: `Non-final chunk must be exactly ${manifest.chunkSize} bytes` },
      { status: 400 }
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const updated = await persistAsyncUploadChunk(session, { seq, data: buffer });

    return NextResponse.json({
      success: true,
      seq,
      receivedCount: updated.receivedSeqs.length,
      totalChunks: updated.totalChunks,
    });
  } catch (error) {
    console.error('Async upload chunk error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save chunk' },
      { status: 500 }
    );
  }
}
