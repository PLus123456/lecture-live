/**
 * 初始化文件分片上传会话。前端在拿到 sessionId 后、开始上传 chunks 前调用一次。
 *
 * 写入 manifest 元数据：原始文件名 / MIME / 总大小 / 分片数 / 分片大小。
 * 同时把 session.asyncTranscribeStatus 置为 'uploading_chunks'，标记走 async 路径。
 */
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership, parsePositiveInteger, sanitizeTextInput } from '@/lib/security';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  reserveTranscriptionMinutes,
  releaseTranscriptionMinutes,
  settleAsyncReservation,
  reserveStorageMinutes,
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
  const bytesPerMin = /^video\//i.test(originalMimeType)
    ? VIDEO_BYTES_PER_MIN
    : AUDIO_BYTES_PER_MIN;
  // 按文件大小估算的分钟 —— 服务端可信下界（originalSize 已在上游 parsePositiveInteger 校验）。
  const sizeFloorMinutes = Math.max(1, Math.ceil(originalSize / bytesPerMin));
  const declaredMinutes =
    estimatedDurationMs != null && estimatedDurationMs > 0
      ? getBillableMinutes(estimatedDurationMs)
      : 0;
  // B2：门禁预估取「客户端声明」与「按文件大小估算」的较大者。客户端声明的 estimatedDurationMs
  // 不可信（可恶意压到 1ms 骗过门禁上传超大文件），故以 size floor 兜底，宁高估勿低估——
  // 高估至多误拒一次上传，低估则让接近耗尽的用户击穿额度。
  return Math.max(declaredMinutes, sizeFloorMinutes);
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

  // P0-6：async 上传管线的产物写盘会**覆盖** session.recordingPath（asyncUploadProcessor 第 4 步
  // persistSessionAudioArtifact → setStatus 落 recordingPath），故绝不能跑在已收尾的会话上——否则
  // 会把已 COMPLETED/ARCHIVED 会话的最终录音覆盖/删除（固定 key 写盘直接冲掉原文件）。入口即拒终态
  // 会话，机器可读 code 便于前端分支。（更深的加固——asyncUploadProcessor 侧 staging+CAS 写产物——
  // 见 handoffs 延后；此状态门禁已堵住主要的录音损坏路径。）
  if (session.status === 'COMPLETED' || session.status === 'ARCHIVED') {
    return NextResponse.json(
      {
        error: 'Cannot start async upload on a finalized session',
        code: 'session_finalized',
      },
      { status: 409 }
    );
  }

  let body: {
    originalFileName?: unknown;
    originalMimeType?: unknown;
    originalSize?: unknown;
    totalChunks?: unknown;
    chunkSize?: unknown;
    estimatedDurationMs?: unknown;
    expectedSha256?: unknown;
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

  // 前端可选声明的整文件 sha256（十六进制 64 位）。merge 时复算比对（P1-15）；格式不符则忽略。
  const rawHash = typeof body.expectedSha256 === 'string' ? body.expectedSha256.trim().toLowerCase() : '';
  const expectedSha256 = /^[a-f0-9]{64}$/.test(rawHash) ? rawHash : null;

  // 前端可选声明的媒体时长（拿不到时为 null，回落按文件大小粗估）。
  const rawDuration = Number(body.estimatedDurationMs);
  const estimatedDurationMs =
    Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null;
  const estimatedMinutes = estimateBillableMinutes(
    estimatedDurationMs,
    originalSize,
    originalMimeType
  );

  // 异步上传转录要计费（批2 + B1）：入口用「投影后的预估分钟」做原子配额预留，取代旧的
  // 非原子 checkQuota（仅判 used<limit）。这修三个洞：①投影漏洞——还剩 1 分钟也能传 300
  // 分钟文件；②并发击穿——多个上传同时通过读检查后叠加超额；③B1——旧实现把预留在本请求结束
  // 就释放（finally），预留只持有几十毫秒，权威扣费在 finalize 且无上限，故门禁形同虚设、
  // 月度额度可被无限突破。
  //
  // B1 修复：预留成功后**持有到 finalize/cancel/删会话/回收**，不再本请求结束就释放。预留额
  // 记入 session.asyncReservedMinutes（同时已计入 transcriptionMinutesUsed）；finalize 时把预留
  // 「转」为实扣（release 预留 + deduct 实际），cancel/删会话 inline 释放、其余终态由 cron 兜底。
  // 这样多个在途上传各自持有预留、真正叠加占额，杜绝超额准入。
  // P1-13（契约6）：存储小时门禁。此前 async 上传入口只判转录分钟、完全不判 storageHoursLimit，
  // 用户可借上传无限累积录音时长。这里按声明时长投影出的分钟做读时存储校验：超限直接拒，绝不进入
  // 转录预留 / 建 manifest。storageHoursUsed 走 SUM(session.durationMs)——本次上传的 durationMs 尚未
  // 写入（转码后才落库），故不会自我双计。降级为读时校验（非原子），并发轻微超限由后续入口/对账收敛。
  const storage = await reserveStorageMinutes(user.id, id, estimatedMinutes);
  if (!storage.ok) {
    return NextResponse.json(
      { error: 'Storage quota exceeded', remainingMinutes: storage.remaining },
      { status: 403 }
    );
  }

  const reserved = await reserveTranscriptionMinutes(user.id, estimatedMinutes);
  if (!reserved) {
    return NextResponse.json({ error: 'Quota exceeded' }, { status: 403 });
  }

  // ── 原子 claim（U42 状态机守卫 + B1 预留登记）──
  // 在一个事务里 FOR UPDATE 锁住会话行 → 校验状态 ∈ {null,uploading_chunks,failed,canceled} →
  // 置 uploading_chunks 并把本次预留额写入 asyncReservedMinutes；若行上已有旧预留（re-init 重来、
  // 或并发的另一 init 顶替），在同一事务内 releaseTranscriptionMinutes 释放它。
  //
  // 为何用 FOR UPDATE 事务而非裸 updateMany：'uploading_chunks' 在允许集内 → 同会话两个并发 init
  // 都能匹配 updateMany 而各自 count===1（都"赢"claim），各留一份预留、只有后写者进 col → 另一份
  // 预留永久泄漏；且各自按请求开头快照裸减旧预留会双释放。FOR UPDATE 串行化并发 init：后到者读到
  // 前者刚写入的预留并原子释放，净预留恒 = 本次 estimatedMinutes，杜绝泄漏与双释放（审查 R3/R4/R5/R8/R9）。
  let claimOutcome: 'claimed' | 'conflict' | 'notfound';
  try {
    claimOutcome = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ asyncTranscribeStatus: string | null; asyncReservedMinutes: number }>
      >(
        Prisma.sql`SELECT asyncTranscribeStatus, asyncReservedMinutes FROM Session WHERE id = ${id} FOR UPDATE`
      );
      const row = rows[0];
      if (!row) {
        return 'notfound' as const;
      }
      const status = row.asyncTranscribeStatus;
      const allowed =
        status === null ||
        status === 'uploading_chunks' ||
        status === 'failed' ||
        status === 'canceled';
      if (!allowed) {
        return 'conflict' as const;
      }
      const prior = row.asyncReservedMinutes ?? 0;
      await tx.session.update({
        where: { id },
        data: {
          asyncTranscribeStatus: 'uploading_chunks',
          asyncTranscribeError: null,
          asyncTranscribeStartedAt: new Date(),
          asyncReservedMinutes: estimatedMinutes,
        },
      });
      if (prior > 0) {
        // 释放被本次顶替掉的旧预留（re-init / 并发 init）——在锁内读到的精确旧值，恰好一次。
        await releaseTranscriptionMinutes(user.id, prior, tx);
      }
      return 'claimed' as const;
    });
  } catch (txErr) {
    // claim 事务本身失败（DB 故障）：撤销本次预留，返回 500。
    await releaseTranscriptionMinutes(user.id, estimatedMinutes).catch(() => undefined);
    console.error('Async upload init claim tx error:', txErr);
    return NextResponse.json(
      { error: 'Failed to initialize async upload' },
      { status: 500 }
    );
  }

  if (claimOutcome !== 'claimed') {
    // 抢不到（会话正在跑/已完成）或会话不存在：撤销本次预留，不动会话已有的预留。
    await releaseTranscriptionMinutes(user.id, estimatedMinutes).catch(() => undefined);
    if (claimOutcome === 'notfound') {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    return NextResponse.json(
      {
        error: `Cannot init: async transcription already in progress (status is ${
          session.asyncTranscribeStatus ?? 'null'
        })`,
      },
      { status: 409 }
    );
  }

  // claim 成功（本次预留已登记在 asyncReservedMinutes）：写盘。
  try {
    const manifest = await initAsyncUpload(session, {
      originalFileName,
      originalMimeType,
      originalSize,
      totalChunks,
      chunkSize,
      expectedSha256,
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
    // initAsyncUpload 失败：把会话退回 failed，并用 settleAsyncReservation 原子结算本次预留
    // （读当前列并释放，恰好一次；若并发 cancel/cron 已释放则读到 0、不重复释放）。
    console.error('Async upload init error:', error);
    await prisma.session
      .updateMany({
        where: { id, asyncTranscribeStatus: 'uploading_chunks' },
        data: {
          asyncTranscribeStatus: 'failed',
          asyncTranscribeError: 'init failed',
        },
      })
      .catch(() => undefined);
    await settleAsyncReservation(id).catch(() => undefined);
    return NextResponse.json(
      { error: 'Failed to initialize async upload' },
      { status: 500 }
    );
  }
}
