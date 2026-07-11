/**
 * 前端轮询的状态 endpoint。
 *
 * 职责：
 * 1. 读 session.asyncTranscribeStatus 返回当前阶段
 * 2. 如果是 'transcribing' 且有 sonioxTranscriptionId，去 Soniox poll 一次
 * 3. Soniox 报告 completed：拉 transcript → 写入 session → 删 Soniox 文件 + transcription → 标 completed
 * 4. Soniox 报告 error：标 failed + 记错误信息
 *
 * 并发安全：用 updateMany WHERE status='transcribing' 做单 process 内的"claim"，
 * 多个并发 poll 只有一个会执行 finish 步骤；其它读到 'finalizing' 直接返回。
 */
import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { invalidateSessionsApiCache } from '@/lib/apiResponseCache';
import { assertOwnership } from '@/lib/security';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getTranscodingProgress } from '@/lib/audio/asyncUploadProcessor';
import { resolveSonioxConfigForSessionRegion } from '@/lib/soniox/env';
import {
  deleteSonioxFile,
  deleteSonioxTranscription,
  getSonioxTranscription,
} from '@/lib/soniox/asyncFile';
import { finalizeAsyncTranscription } from '@/lib/audio/asyncTranscribeFinalize';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 高频 poll：每秒一次，10 分钟内 600 次，留够余量
  const rateLimited = await enforceRateLimit(req, {
    scope: 'sessions:async-transcribe-status',
    limit: 1200,
    windowMs: 10 * 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) return rateLimited;

  const session = await prisma.session.findUnique({
    where: { id },
    include: { folders: { select: { folderId: true } } },
  });
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  try {
    assertOwnership(user.id, session.userId);
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  // 不是 async 路径 → 直接返回 null 状态
  if (!session.asyncTranscribeStatus) {
    return NextResponse.json({ status: null });
  }

  // 已经到终态，无需再 poll Soniox
  if (
    session.asyncTranscribeStatus === 'completed' ||
    session.asyncTranscribeStatus === 'failed' ||
    session.asyncTranscribeStatus === 'canceled'
  ) {
    return NextResponse.json({
      status: session.asyncTranscribeStatus,
      error: session.asyncTranscribeError ?? undefined,
    });
  }

  // 还没到 transcribing（仍在合并/转码/上传），不动 Soniox，直接返回当前状态。
  // transcoding 阶段额外带上 ffmpeg 实时进度，让前端进度条能动起来。
  if (
    session.asyncTranscribeStatus !== 'transcribing' ||
    !session.sonioxTranscriptionId
  ) {
    const payload: { status: string; processingProgress?: number } = {
      status: session.asyncTranscribeStatus,
    };
    if (session.asyncTranscribeStatus === 'transcoding') {
      payload.processingProgress = getTranscodingProgress(session.id);
    }
    return NextResponse.json(payload);
  }

  // ── poll Soniox ──
  // P1-16：按任务开始时固定的 region 解析配置，绝不落回可变默认 region（否则 poll/delete 去错 region）。
  const sonioxConfig = await resolveSonioxConfigForSessionRegion(session.sonioxRegion);
  if (!sonioxConfig) {
    return NextResponse.json({ status: session.asyncTranscribeStatus });
  }

  let job;
  try {
    job = await getSonioxTranscription(sonioxConfig, session.sonioxTranscriptionId);
  } catch (err) {
    // Soniox 暂时不通 —— 不改 session 状态，前端继续 poll
    logger.warn({ err, sessionId: session.id }, 'soniox poll failed, will retry');
    return NextResponse.json({ status: session.asyncTranscribeStatus });
  }

  if (job.status === 'queued' || job.status === 'processing') {
    return NextResponse.json({
      status: session.asyncTranscribeStatus,
      sonioxStatus: job.status,
    });
  }

  if (job.status === 'error') {
    const errMsg = job.error_message || 'Soniox transcription failed';
    await prisma.session.updateMany({
      where: { id: session.id, asyncTranscribeStatus: 'transcribing' },
      data: {
        asyncTranscribeStatus: 'failed',
        asyncTranscribeError: errMsg,
      },
    });
    // 失败也尽力清理 Soniox 上的文件 + transcription
    if (session.sonioxFileId) {
      await deleteSonioxFile(sonioxConfig, session.sonioxFileId).catch(() => undefined);
    }
    await deleteSonioxTranscription(sonioxConfig, session.sonioxTranscriptionId).catch(
      () => undefined
    );
    return NextResponse.json({
      status: 'failed',
      error: errMsg,
    });
  }

  // ── job.status === 'completed' ──
  // 收尾（claim + 拉 transcript + 落盘 + 扣费）抽到共享 finalizeAsyncTranscription，
  // 与回收兜底（billingMaintenance.reclaimStaleAsyncUploads）复用同一份口径 + 同一道幂等
  // claim（WHERE asyncTranscribeStatus IN ['transcribing'] → 'finalizing'），确保「前端 poll
  // vs 回收」二选一执行、绝不双扣。
  try {
    const result = await finalizeAsyncTranscription(
      {
        id: session.id,
        userId: session.userId,
        sonioxFileId: session.sonioxFileId,
        sonioxTranscriptionId: session.sonioxTranscriptionId,
        targetLang: session.targetLang,
        durationMs: session.durationMs,
        recordingPath: session.recordingPath,
        title: session.title,
        courseName: session.courseName,
        createdAt: session.createdAt,
        folderIds: session.folders.map((f) => f.folderId),
      },
      sonioxConfig,
      {
        allowClaimFrom: ['transcribing'],
        onCompleted: () => invalidateSessionsApiCache(user.id),
      }
    );

    if (result.outcome === 'claim_lost') {
      // 另一个 poll（或回收）已经在收尾。读最新状态返回。
      const fresh = await prisma.session.findUnique({ where: { id: session.id } });
      return NextResponse.json({
        status: fresh?.asyncTranscribeStatus ?? 'transcribing',
        error: fresh?.asyncTranscribeError ?? undefined,
      });
    }

    if (result.outcome === 'canceled_during_finalize') {
      // 收尾期间会话已被取消/改状态：未扣费、未跑 LLM、已清 Soniox 资源，读最新状态返回。
      const fresh = await prisma.session.findUnique({ where: { id: session.id } });
      return NextResponse.json({
        status: fresh?.asyncTranscribeStatus ?? 'canceled',
        error: fresh?.asyncTranscribeError ?? undefined,
      });
    }

    return NextResponse.json({
      status: 'completed',
      sessionId: session.id,
      segmentCount: result.segmentCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, sessionId: session.id }, 'failed to finalize async transcript');

    // U59：区分瞬时错误与永久错误。此刻 Soniox 侧转录早已 completed（transcript 就绪），
    // 拉取阶段的网络抖动 / 30s 超时 / 上游 5xx 都是可重试的瞬时故障——若一遇错就标 failed，
    // 会把一份已经产出的转录永久丢弃。瞬时错误回退到 transcribing，让下一次 poll 重新
    // 抢锁重试；只有解析/落盘等确定性永久错误才标 failed。
    // 回退/标失败都用 WHERE asyncTranscribeStatus='finalizing' 守卫，避免覆盖并发 cancel。
    if (isTransientFinalizeError(err)) {
      await prisma.session.updateMany({
        where: { id: session.id, asyncTranscribeStatus: 'finalizing' },
        data: { asyncTranscribeStatus: 'transcribing' },
      });
      // 对前端保持 transcribing —— 轮询会继续，下一轮重试收尾
      return NextResponse.json({ status: 'transcribing', retryable: true });
    }

    await prisma.session.updateMany({
      where: { id: session.id, asyncTranscribeStatus: 'finalizing' },
      data: {
        asyncTranscribeStatus: 'failed',
        asyncTranscribeError: `Finalize failed: ${message}`,
      },
    });
    return NextResponse.json({ status: 'failed', error: message });
  }
}

/**
 * 判定异步转录收尾阶段抛出的错误是否为「瞬时、可重试」。
 *
 * 收尾阶段唯一的网络调用是 getSonioxTranscript（拉 transcript）。它在 HTTP 非 2xx 时抛
 * `Soniox get transcript failed: HTTP <status>`；在 30s 超时时由 AbortSignal.timeout 抛出
 * name='TimeoutError' 的 DOMException；底层网络故障（DNS/连接重置）抛 name='AbortError'
 * 或 TypeError('fetch failed')。这些都属于「Soniox 侧转录已完成、只是取回失败」的瞬时故障，
 * 回退 transcribing 重试即可自愈。
 *
 * 反之，解析 token / 落盘 / DB 写入等确定性错误重试也不会好转，视为永久错误标 failed。
 */
function isTransientFinalizeError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return true;

  const message = err instanceof Error ? err.message : String(err);
  // getSonioxTranscript 的 HTTP 错误：5xx / 429 可重试；4xx（除 429）视为永久
  const httpMatch = /Soniox get transcript failed: HTTP (\d{3})/.exec(message);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    return status === 429 || status >= 500;
  }
  // 底层 fetch 网络故障（Node undici）
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message)) {
    return true;
  }
  return false;
}
