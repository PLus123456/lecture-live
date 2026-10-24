import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership } from '@/lib/security';
import { logger } from '@/lib/logger';
import { resolveSonioxConfigForSessionRegion } from '@/lib/soniox/env';
import {
  getSonioxTranscription,
  deleteSonioxFile,
  deleteSonioxTranscription,
} from '@/lib/soniox/asyncFile';
import { finalizeFullTranscription } from '@/lib/audio/fullTranscribeFinalize';
import { failFullTranscribeAttempt } from '@/lib/audio/fullTranscribeAdmission';
import { isTransientFullTranscribeFinalizeError } from '@/lib/audio/fullTranscribeFinalizeErrors';

// 完整版补全转录状态轮询（前端 poll 驱动收尾，同 async-transcribe-status 模式）：
//   - 终态(completed/failed/null) 直接返回
//   - transcribing 时去 Soniox poll 一次，job completed 就地收尾（claim + 落盘 + 扣费）
const TERMINAL = new Set(['completed', 'failed']);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  try {
    assertOwnership(user.id, session.userId);
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const status = session.fullTranscribeStatus;

  // 未触发 / 已终态：直接返回
  if (!status || TERMINAL.has(status)) {
    return NextResponse.json({
      status: status ?? null,
      error: session.fullTranscribeError ?? null,
      hasFullTranscript: Boolean(session.fullTranscriptPath),
    });
  }

  // pending / transcoding / finalizing：仍在处理，返回当前状态（不 poll Soniox）
  if (status !== 'transcribing' || !session.fullSonioxTranscriptionId) {
    return NextResponse.json({
      status,
      error: null,
      hasFullTranscript: Boolean(session.fullTranscriptPath),
    });
  }

  // ── transcribing：poll Soniox 一次 ──
  // P1-16：按任务开始时固定的 region 解析配置，绝不落回可变默认 region。
  const sonioxConfig = await resolveSonioxConfigForSessionRegion(session.sonioxRegion);
  if (!sonioxConfig) {
    return NextResponse.json({ status, error: null, hasFullTranscript: false });
  }

  let job;
  try {
    job = await getSonioxTranscription(sonioxConfig, session.fullSonioxTranscriptionId);
  } catch (err) {
    // Soniox 暂时不通：不改状态，前端继续 poll
    logger.warn({ err, sessionId: id }, 'full transcribe soniox poll failed, will retry');
    return NextResponse.json({ status, error: null, hasFullTranscript: false });
  }

  if (job.status === 'queued' || job.status === 'processing') {
    return NextResponse.json({ status: 'transcribing', error: null, hasFullTranscript: false });
  }

  if (job.status === 'error') {
    // claim-bound failed transition and quota release are one Session→User transaction. Splitting
    // them would let a retrigger reserve claim B between A's failure and A's late settlement.
    const failed = await failFullTranscribeAttempt({
      sessionId: id,
      claimId: session.fullTranscribeClaimId,
      allowedStatuses: ['transcribing'],
      error: 'Soniox transcription failed',
    }).catch(() => false);
    // 抢到才清 Soniox 残留（file + errored transcription）：不让 error 态会话把 Soniox 侧配额
    // 泄漏到「删会话/重触发」才回收（与 cron mark-failed 同口径）。best-effort、幂等、失败不抛。
    // 此处 fullSonioxTranscriptionId 必非空（上方 status!=='transcribing' || 无 id 已提前返回）。
    if (failed) {
      if (session.fullSonioxFileId) {
        await deleteSonioxFile(sonioxConfig, session.fullSonioxFileId).catch(() => undefined);
      }
      await deleteSonioxTranscription(
        sonioxConfig,
        session.fullSonioxTranscriptionId
      ).catch(() => undefined);
    }
    if (!failed) {
      const latest = await prisma.session.findUnique({
        where: { id },
        select: {
          fullTranscribeStatus: true,
          fullTranscribeError: true,
          fullTranscriptPath: true,
        },
      });
      return NextResponse.json({
        status: latest?.fullTranscribeStatus ?? 'transcribing',
        error: latest?.fullTranscribeError ?? null,
        hasFullTranscript: Boolean(latest?.fullTranscriptPath),
      });
    }
    return NextResponse.json({
      status: 'failed',
      error: 'Soniox transcription failed',
      hasFullTranscript: false,
    });
  }

  // ── job.status === 'completed'：就地收尾（claim 保证前端 poll / cron 回收互斥、扣费一次）──
  try {
    const result = await finalizeFullTranscription(session, sonioxConfig);
    if (result.outcome === 'completed') {
      return NextResponse.json({
        status: 'completed',
        error: null,
        hasFullTranscript: true,
        segmentCount: result.segmentCount,
      });
    }
    // claim_lost / canceled：读最新状态返回
    const latest = await prisma.session.findUnique({
      where: { id },
      select: { fullTranscribeStatus: true, fullTranscriptPath: true },
    });
    return NextResponse.json({
      status: latest?.fullTranscribeStatus ?? 'transcribing',
      error: null,
      hasFullTranscript: Boolean(latest?.fullTranscriptPath),
    });
  } catch (err) {
    // 拉 transcript / 落盘失败：先回退 transcribing（claim 已置 finalizing；finalize 抛出前通常已
    // 自行回退，这里兜住「那次回退本身失败」，条件更新绝不覆盖别的 claim）。
    const transient = isTransientFullTranscribeFinalizeError(err);
    logger.error(
      { err, sessionId: id, transient },
      transient
        ? 'full transcribe finalize failed (transient), reverting'
        : 'full transcribe finalize failed permanently'
    );
    await prisma.session.updateMany({
      where: {
        id,
        fullTranscribeClaimId: session.fullTranscribeClaimId,
        fullTranscribeStatus: 'finalizing',
      },
      data: { fullTranscribeStatus: 'transcribing' },
    });
    if (transient) {
      return NextResponse.json({ status: 'transcribing', error: null, hasFullTranscript: false });
    }

    // 审计 #8：永久失败（准入拒绝 / 超字节上限 / 确定性 4xx 等）重试不会自愈。旧实现一律回退
    // transcribing：每次 poll 重下 transcript 再失败，任务永久卡住、占着补全名额与额度预留。
    // 这里与 Soniox error 分支同口径：claim 绑定地标 failed 并在同一事务里释放预留（名额随终态
    // 释放）。只从 transcribing 转出 —— 回退之后若并发 poll 已重新 claim，交给它，不报旧失败。
    // 原始错误只进日志（可能含服务端路径），对用户只回固定文案。
    const publicError = 'Full transcription could not be finalized';
    const failed = await failFullTranscribeAttempt({
      sessionId: id,
      claimId: session.fullTranscribeClaimId,
      allowedStatuses: ['transcribing'],
      error: publicError,
    }).catch(() => false);
    if (!failed) {
      const latest = await prisma.session.findUnique({
        where: { id },
        select: {
          fullTranscribeStatus: true,
          fullTranscribeError: true,
          fullTranscriptPath: true,
        },
      });
      return NextResponse.json({
        status: latest?.fullTranscribeStatus ?? 'transcribing',
        error: latest?.fullTranscribeError ?? null,
        hasFullTranscript: Boolean(latest?.fullTranscriptPath),
      });
    }
    // 抢到终态才清 Soniox 残留（与 error 分支一致，best-effort；未确认删除的 ID 留作
    // reclaimOrphanSonioxResources 的 outbox 重试）。
    if (session.fullSonioxFileId) {
      await deleteSonioxFile(sonioxConfig, session.fullSonioxFileId).catch(() => undefined);
    }
    await deleteSonioxTranscription(
      sonioxConfig,
      session.fullSonioxTranscriptionId
    ).catch(() => undefined);
    return NextResponse.json({ status: 'failed', error: publicError, hasFullTranscript: false });
  }
}
