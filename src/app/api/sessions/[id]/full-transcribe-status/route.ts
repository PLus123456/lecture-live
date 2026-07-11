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
import { settleFullReservation } from '@/lib/quota';

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
    const failed = await prisma.session.updateMany({
      where: { id, fullTranscribeStatus: 'transcribing' },
      data: {
        fullTranscribeStatus: 'failed',
        fullTranscribeError: 'Soniox transcription failed',
      },
    });
    // R4：任务失败 → 释放入口持有的转录分钟预留（fullReservedMinutes）。抢到 failed 才释放。
    // settleFullReservation 用 FOR UPDATE 读当前列并原子释放，与 finalize 结算 / 删会话 / cron
    // releaseOrphanFullReservations 互斥，恰好释放一次。
    if (failed.count === 1) {
      await settleFullReservation(id).catch(() => undefined);
    }
    // 抢到才清 Soniox 残留（file + errored transcription）：不让 error 态会话把 Soniox 侧配额
    // 泄漏到「删会话/重触发」才回收（与 cron mark-failed 同口径）。best-effort、幂等、失败不抛。
    // 此处 fullSonioxTranscriptionId 必非空（上方 status!=='transcribing' || 无 id 已提前返回）。
    if (failed.count === 1) {
      if (session.fullSonioxFileId) {
        await deleteSonioxFile(sonioxConfig, session.fullSonioxFileId).catch(() => undefined);
      }
      await deleteSonioxTranscription(
        sonioxConfig,
        session.fullSonioxTranscriptionId
      ).catch(() => undefined);
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
    // 拉 transcript / 落盘失败：回退 transcribing 让下次 poll 重试（claim 已置 finalizing）。
    logger.error({ err, sessionId: id }, 'full transcribe finalize failed, reverting');
    await prisma.session.updateMany({
      where: { id, fullTranscribeStatus: 'finalizing' },
      data: { fullTranscribeStatus: 'transcribing' },
    });
    return NextResponse.json({ status: 'transcribing', error: null, hasFullTranscript: false });
  }
}
