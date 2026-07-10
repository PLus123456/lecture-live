import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership } from '@/lib/security';
import { withRequestLogging } from '@/lib/requestLogger';
import { loadFullTranscript } from '@/lib/audio/fullTranscribeFinalize';

// 读取完整版补全转录 bundle（回放页「完整版转录」视图）。
// 与实时转录读取端点（transcript/route.ts GET）平行、完全独立：读 fullTranscriptPath 落盘的 JSON。
// 与 full-transcribe / full-transcribe-status 一致做 owner-only 鉴权。
export const GET = withRequestLogging(
  'sessions:full-transcript-read',
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

    // 尚未生成 / 文件缺失 / 损坏：降级为空 bundle（前端据 hasFullTranscript 决定是否展示切换）。
    const bundle = await loadFullTranscript(session);
    if (!bundle) {
      return NextResponse.json({
        segments: [],
        summaries: [],
        translations: {},
        hasFullTranscript: false,
      });
    }

    return NextResponse.json({ ...bundle, hasFullTranscript: true });
  }
);
