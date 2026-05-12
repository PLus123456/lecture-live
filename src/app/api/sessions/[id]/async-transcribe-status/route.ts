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
import { persistSessionTranscriptArtifacts } from '@/lib/sessionPersistence';
import { resolveSonioxRuntimeConfigAsync } from '@/lib/soniox/env';
import {
  deleteSonioxFile,
  deleteSonioxTranscription,
  getSonioxTranscript,
  getSonioxTranscription,
} from '@/lib/soniox/asyncFile';
import { convertAsyncTokensToSegments } from '@/lib/soniox/asyncTranscriptConverter';

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

  const session = await prisma.session.findUnique({ where: { id } });
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

  // 还没到 transcribing（仍在合并/转码/上传），不动 Soniox，直接返回当前状态
  if (
    session.asyncTranscribeStatus !== 'transcribing' ||
    !session.sonioxTranscriptionId
  ) {
    return NextResponse.json({ status: session.asyncTranscribeStatus });
  }

  // ── poll Soniox ──
  const sonioxConfig = await resolveSonioxRuntimeConfigAsync({});
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
  // 用 updateMany WHERE status='transcribing' 抢锁，只有一个并发 poll 能进 finish 分支
  const claim = await prisma.session.updateMany({
    where: { id: session.id, asyncTranscribeStatus: 'transcribing' },
    data: { asyncTranscribeStatus: 'finalizing' },
  });

  if (claim.count !== 1) {
    // 另一个 poll 已经在收尾。读最新状态返回。
    const fresh = await prisma.session.findUnique({ where: { id: session.id } });
    return NextResponse.json({
      status: fresh?.asyncTranscribeStatus ?? 'transcribing',
      error: fresh?.asyncTranscribeError ?? undefined,
    });
  }

  try {
    const transcript = await getSonioxTranscript(
      sonioxConfig,
      session.sonioxTranscriptionId
    );
    const segments = convertAsyncTokensToSegments(transcript.tokens, {
      targetLang: session.targetLang,
    });

    const persisted = await persistSessionTranscriptArtifacts(session, {
      segments,
      summaries: [],
      translations: {},
    });

    await prisma.session.update({
      where: { id: session.id },
      data: {
        asyncTranscribeStatus: 'completed',
        transcriptPath: persisted.transcript.path,
        summaryPath: persisted.summary.path,
        // 清掉 Soniox 引用 —— 文件已经删了/即将删
        sonioxFileId: null,
        sonioxTranscriptionId: null,
        status: 'COMPLETED',
      },
    });
    await invalidateSessionsApiCache(user.id);

    // 删 Soniox 上的资源（幂等，失败不抛）
    if (session.sonioxFileId) {
      await deleteSonioxFile(sonioxConfig, session.sonioxFileId).catch(() => undefined);
    }
    await deleteSonioxTranscription(sonioxConfig, session.sonioxTranscriptionId).catch(
      () => undefined
    );

    return NextResponse.json({
      status: 'completed',
      sessionId: session.id,
      segmentCount: segments.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, sessionId: session.id }, 'failed to finalize async transcript');
    // 释放 claim：标 failed 而不是回滚到 transcribing，避免反复抢锁
    await prisma.session.update({
      where: { id: session.id },
      data: {
        asyncTranscribeStatus: 'failed',
        asyncTranscribeError: `Finalize failed: ${message}`,
      },
    });
    return NextResponse.json({ status: 'failed', error: message });
  }
}
