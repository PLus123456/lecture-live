import { NextResponse } from 'next/server';
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

    // ── 配额准入：按 ceil(可计费分钟 × 异步倍率) 预估，试占后立即释放（只做准入判定，
    // 实际扣费在 finalize）。不够则拒绝，前端提示额度不足。──
    const { async_upload_billing_multiplier } = await getSiteSettings();
    const estimatedMinutes = Math.ceil(
      getBillableMinutes(session.durationMs) * async_upload_billing_multiplier
    );
    if (estimatedMinutes > 0) {
      const ok = await reserveTranscriptionMinutes(user.id, estimatedMinutes);
      if (!ok) {
        return NextResponse.json(
          { error: 'Insufficient transcription quota', estimatedMinutes },
          { status: 402 }
        );
      }
      await releaseTranscriptionMinutes(user.id, estimatedMinutes);
    }

    // ── 原子 claim：仅当 fullTranscribeStatus 空或处于终态(failed/completed)时置 'pending' ──
    const claim = await prisma.session.updateMany({
      where: {
        id,
        OR: [
          { fullTranscribeStatus: null },
          { fullTranscribeStatus: { in: ['failed', 'completed'] } },
        ],
      },
      data: {
        fullTranscribeStatus: 'pending',
        fullTranscribeError: null,
        fullTranscribeStartedAt: new Date(),
      },
    });
    if (claim.count !== 1) {
      // 并发下已被另一个请求抢先启动。
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
