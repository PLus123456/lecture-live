/**
 * 列出当前用户所有"未收尾"的 async 上传转录 session。
 *
 * 用途：页面刷新后，UploadJobsTracker 靠这个 endpoint 把僵尸 session 找回来——
 * 进行中的重新挂 poll，uploading_chunks 的清理掉，failed 的展示出来。
 *
 * 路由说明：本静态段 active-async 与同级动态段 [id] 并存。Next.js 静态段优先级
 * 高于动态段，所以 /api/sessions/active-async 命中本路由而非 [id]。
 */
import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withRequestLogging } from '@/lib/requestLogger';

const ACTIVE_ASYNC_STATUSES = [
  'uploading_chunks',
  'transcoding',
  'uploading_to_soniox',
  'transcribing',
  'finalizing',
  'failed',
];

export const GET = withRequestLogging(
  'sessions:active-async',
  async (req: Request) => {
    const user = await verifyAuth(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rateLimited = await enforceRateLimit(req, {
      scope: 'sessions:active-async',
      limit: 120,
      windowMs: 10 * 60_000,
      key: `user:${user.id}`,
    });
    if (rateLimited) return rateLimited;

    const jobs = await prisma.session.findMany({
      where: {
        userId: user.id,
        asyncTranscribeStatus: { in: ACTIVE_ASYNC_STATUSES },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        asyncTranscribeStatus: true,
        asyncTranscribeError: true,
      },
    });

    return NextResponse.json({ jobs });
  }
);
