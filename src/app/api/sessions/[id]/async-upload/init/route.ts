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
import {
  reserveTranscriptionMinutes,
  releaseTranscriptionMinutes,
} from '@/lib/quota';
import { getBillableMinutes } from '@/lib/billing';
import { initAsyncUpload } from '@/lib/audio/asyncUploadChunkPersistence';

// 单文件总大小上限：5 GB（足以覆盖 5 小时 1080p mp4）
const MAX_TOTAL_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_CHUNK_BYTES = 20 * 1024 * 1024;
const MIN_CHUNK_BYTES = 64 * 1024;
const ACCEPTED_MEDIA_RE = /^(audio|video)\//i;

// 按文件大小粗估时长的 fallback（与前端 UploadTranscribeModal 的口径一致）：
// 视频 ~5MB/min、音频 ~1MB/min。仅当前端未声明 estimatedDurationMs 时使用。
const VIDEO_BYTES_PER_MIN = 5 * 1024 * 1024;
const AUDIO_BYTES_PER_MIN = 1 * 1024 * 1024;

/**
 * 估算本次异步上传的计费分钟，用于入口处的原子配额预留（投影后判 limit）。
 * 优先用前端声明的 estimatedDurationMs；缺失时按 originalSize/MIME 粗估，与前端 fallback 同口径。
 * 始终向上取整为整分钟，宁可略高估也不低估（低估会让接近耗尽的用户击穿额度）。
 */
function estimateBillableMinutes(
  estimatedDurationMs: number | null,
  originalSize: number,
  originalMimeType: string
): number {
  if (estimatedDurationMs != null && estimatedDurationMs > 0) {
    return getBillableMinutes(estimatedDurationMs);
  }
  const bytesPerMin = /^video\//i.test(originalMimeType)
    ? VIDEO_BYTES_PER_MIN
    : AUDIO_BYTES_PER_MIN;
  return Math.max(1, Math.ceil(originalSize / bytesPerMin));
}

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

  let body: {
    originalFileName?: unknown;
    originalMimeType?: unknown;
    originalSize?: unknown;
    totalChunks?: unknown;
    chunkSize?: unknown;
    estimatedDurationMs?: unknown;
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

  // 前端可选声明的媒体时长（拿不到时为 null，回落按文件大小粗估）。
  const rawDuration = Number(body.estimatedDurationMs);
  const estimatedDurationMs =
    Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null;
  const estimatedMinutes = estimateBillableMinutes(
    estimatedDurationMs,
    originalSize,
    originalMimeType
  );

  // 异步上传转录要计费（批2）：入口用「投影后的预估分钟」做原子配额预留，取代旧的
  // 非原子 checkQuota（仅判 used<limit）。这同时修两个洞：①投影漏洞——还剩 1 分钟也能
  // 传 300 分钟文件；②并发击穿——多个上传同时通过读检查后叠加超额。reserve 用一条
  // `UPDATE ... WHERE used+est<=limit` 原子完成校验+占用。
  //
  // 注意：转录完成时（async-transcribe-status，属另一单元）才按 ceil(分钟)×倍率 做权威扣费。
  // 为避免与那笔扣费重复计费，这里**仅把预留作为准入判定**，在本请求结束前（成功/失败）
  // 都释放掉预留——即原子地“试占”而不长期持有。这样既挡住超额准入，又不会双重计费。
  const reserved = await reserveTranscriptionMinutes(user.id, estimatedMinutes);
  if (!reserved) {
    return NextResponse.json({ error: 'Quota exceeded' }, { status: 403 });
  }

  try {
    // 状态机守卫（U42）：只有处于"尚未进入后台 pipeline"的状态才允许（重新）init。
    // 旧代码用 id-only 的无条件 update 置 uploading_chunks，能把已经在 transcoding /
    // uploading_to_soniox / transcribing / finalizing / completed 的会话打回 uploading_chunks，
    // 引发双 pipeline 启动、覆写已上传/已转录产物、乃至对已完成会话重复 init。
    // 用一条原子 updateMany，仅当当前状态 ∈ {null, uploading_chunks, failed, canceled} 才置位；
    // 抢不到（会话正在跑或已完成）→ 409，不写 manifest、不动状态。
    const claimed = await prisma.session.updateMany({
      where: {
        id,
        OR: [
          { asyncTranscribeStatus: null },
          {
            asyncTranscribeStatus: {
              in: ['uploading_chunks', 'failed', 'canceled'],
            },
          },
        ],
      },
      data: {
        asyncTranscribeStatus: 'uploading_chunks',
        asyncTranscribeError: null,
        asyncTranscribeStartedAt: new Date(),
      },
    });
    if (claimed.count !== 1) {
      return NextResponse.json(
        {
          error: `Cannot init: async transcription already in progress (status is ${
            session.asyncTranscribeStatus ?? 'null'
          })`,
        },
        { status: 409 }
      );
    }

    const manifest = await initAsyncUpload(session, {
      originalFileName,
      originalMimeType,
      originalSize,
      totalChunks,
      chunkSize,
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
  } finally {
    // 释放准入预留：权威扣费在转录完成时单独进行，避免双重计费。
    await releaseTranscriptionMinutes(user.id, estimatedMinutes).catch(() => undefined);
  }
}
