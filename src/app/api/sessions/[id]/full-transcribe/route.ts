import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership } from '@/lib/security';
import { withRequestLogging } from '@/lib/requestLogger';
import { getBillableMinutes } from '@/lib/billing';
import {
  reserveTranscriptionMinutes,
  releaseTranscriptionMinutes,
} from '@/lib/quota';
import { getSiteSettings } from '@/lib/siteSettings';
import { processFullTranscribe } from '@/lib/audio/fullTranscribeProcessor';

// 完整版补全转录触发：对已录制完成的会话，用其完整音频（含断网续采段）重跑一次 Soniox
// 异步文件转录，产出独立并列的完整转录（不覆盖实时转录）。额外按异步倍率计费。
const ACTIVE_STATES = ['pending', 'transcoding', 'transcribing', 'finalizing'];

export const POST = withRequestLogging(
  'sessions:full-transcribe',
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
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

    // 仅对已录制完成、且有录音的会话可生成完整版转录。
    if (session.status !== 'COMPLETED' && session.status !== 'ARCHIVED') {
      return NextResponse.json(
        { error: 'Session must be finalized before generating a full transcript' },
        { status: 409 }
      );
    }
    if (!session.recordingPath) {
      return NextResponse.json(
        { error: 'Session has no recording to transcribe' },
        { status: 409 }
      );
    }
    // 已在进行中则不重复触发。
    if (session.fullTranscribeStatus && ACTIVE_STATES.includes(session.fullTranscribeStatus)) {
      return NextResponse.json(
        { status: session.fullTranscribeStatus, alreadyRunning: true },
        { status: 200 }
      );
    }

    // ── 配额准入 + 预留持有（R4，对齐 B1 异步上传）──
    // 按 ceil(可计费分钟 × 异步倍率) 预估，原子预留并**持有到 finalize/删会话/回收**（不再试占即释放）。
    // 旧实现「reserve 后立即 release」只做瞬时判定、门禁形同虚设：真正扣费在 fullTranscribeFinalize 且
    // 无上限，并发/连发多个完整版补全可越过月度转录额度上限。现预留额记入 session.fullReservedMinutes
    //（同时已计入 transcriptionMinutesUsed），finalize 时把预留「转」为实扣，删会话 inline 释放、失败
    // 终态由 cron releaseOrphanFullReservations 兜底。多个在途补全各自持有预留、真正叠加占额，杜绝超额准入。
    const { async_upload_billing_multiplier } = await getSiteSettings();
    const estimatedMinutes = Math.ceil(
      getBillableMinutes(session.durationMs) * async_upload_billing_multiplier
    );
    const reserved =
      estimatedMinutes > 0
        ? await reserveTranscriptionMinutes(user.id, estimatedMinutes)
        : true;
    if (!reserved) {
      return NextResponse.json(
        { error: 'Insufficient transcription quota', estimatedMinutes },
        { status: 402 }
      );
    }

    // ── 原子 claim（FOR UPDATE）+ 预留登记 ──
    // 在事务里锁住会话行 → 校验 fullTranscribeStatus 允许启动（空或终态 failed/completed；活动态拒绝）
    // → 置 'pending' 并把本次预留额写入 fullReservedMinutes；若行上已有旧预留（前一轮 failed/completed
    // 尚未被 cron 清、或并发另一次触发顶替），在同一事务内释放它。FOR UPDATE 串行化并发触发：后到者读到
    // 前者刚写入的活动态而放弃（already_running），净预留恒 = 本次 estimatedMinutes，杜绝泄漏与双释放。
    let claimOutcome: 'claimed' | 'already_running' | 'notfound';
    try {
      claimOutcome = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ fullTranscribeStatus: string | null; fullReservedMinutes: number }>
        >(
          Prisma.sql`SELECT fullTranscribeStatus, fullReservedMinutes FROM Session WHERE id = ${id} FOR UPDATE`
        );
        const row = rows[0];
        if (!row) {
          return 'notfound' as const;
        }
        const status = row.fullTranscribeStatus;
        // 活动态（含刚被并发触发置 pending）→ 已在跑，不顶替。
        if (status && ACTIVE_STATES.includes(status)) {
          return 'already_running' as const;
        }
        const prior = row.fullReservedMinutes ?? 0;
        await tx.session.update({
          where: { id },
          data: {
            fullTranscribeStatus: 'pending',
            fullTranscribeError: null,
            fullTranscribeStartedAt: new Date(),
            fullReservedMinutes: estimatedMinutes,
          },
        });
        if (prior > 0) {
          // 释放被本次顶替掉的旧预留（锁内读到的精确旧值，恰好一次）。
          await releaseTranscriptionMinutes(user.id, prior, tx);
        }
        return 'claimed' as const;
      });
    } catch (txErr) {
      // claim 事务本身失败（DB 故障）：撤销本次预留，返回 500。
      if (estimatedMinutes > 0) {
        await releaseTranscriptionMinutes(user.id, estimatedMinutes).catch(() => undefined);
      }
      console.error('Full transcribe claim tx error:', txErr);
      return NextResponse.json(
        { error: 'Failed to start full transcription' },
        { status: 500 }
      );
    }

    if (claimOutcome !== 'claimed') {
      // 抢不到（已在跑）或会话不存在：撤销本次预留，绝不动会话已有的预留。
      if (estimatedMinutes > 0) {
        await releaseTranscriptionMinutes(user.id, estimatedMinutes).catch(() => undefined);
      }
      if (claimOutcome === 'notfound') {
        return NextResponse.json({ error: 'Session not found' }, { status: 404 });
      }
      const latest = await prisma.session.findUnique({
        where: { id },
        select: { fullTranscribeStatus: true },
      });
      return NextResponse.json(
        { status: latest?.fullTranscribeStatus ?? 'pending', alreadyRunning: true },
        { status: 200 }
      );
    }

    // fire-and-forget 后台处理
    void processFullTranscribe(id);

    return NextResponse.json({ status: 'pending', estimatedMinutes });
  }
);
