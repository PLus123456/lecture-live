import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { prisma } from '@/lib/prisma';
import { queryJobs, retryJob, JOB_TYPE, JOB_STATUS } from '@/lib/jobQueue';
import {
  validateJobCleanupParams,
  olderThanDaysToCutoff,
} from '@/lib/adminCleanup';

const VALID_TYPES = new Set(Object.values(JOB_TYPE));
const VALID_STATUSES = new Set(Object.values(JOB_STATUS));

// 获取任务队列（分页 + 筛选） / 清理预览
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  // ─── 清理预览：返回 count 不实际删 ───
  if (searchParams.get('cleanup_preview') === '1') {
    const { response } = await requireAdminAccess(req, {
      scope: 'admin:jobs:cleanup:preview',
      limit: 30,
      windowMs: 60_000,
    });
    if (response) return response;

    const validation = validateJobCleanupParams({
      statuses: searchParams.getAll('statuses'),
      olderThanDays: Number(searchParams.get('olderThanDays')),
      type: searchParams.get('type') || undefined,
    });
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    try {
      const cutoff = olderThanDaysToCutoff(validation.olderThanDays);
      const count = await prisma.jobQueue.count({
        where: {
          status: { in: validation.statuses },
          createdAt: { lt: cutoff },
          ...(validation.type ? { type: validation.type } : {}),
        },
      });
      return NextResponse.json({ count });
    } catch (err) {
      console.error('查询任务清理预览失败:', err);
      return NextResponse.json({ error: '查询失败' }, { status: 500 });
    }
  }

  const { response } = await requireAdminAccess(req, {
    scope: 'admin:jobs:list',
    limit: 60,
  });
  if (response) return response;

  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));
  const type = searchParams.get('type') || '';
  const status = searchParams.get('status') || '';

  try {
    const result = await queryJobs({
      type: type && VALID_TYPES.has(type as never) ? type : undefined,
      status: status && VALID_STATUSES.has(status as never) ? status : undefined,
      page,
      pageSize,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error('查询任务队列失败:', err);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}

// 重试失败任务
export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:jobs:retry',
    limit: 10,
  });
  if (response) return response;

  try {
    const body = await req.json();
    const { jobId } = body as { jobId?: string };

    if (!jobId || typeof jobId !== 'string') {
      return NextResponse.json({ error: '缺少 jobId' }, { status: 400 });
    }

    const ok = await retryJob(jobId);
    if (!ok) {
      return NextResponse.json(
        { error: '无法重试：任务不存在、未失败或已达最大重试次数' },
        { status: 409 },
      );
    }

    logAction(req, 'admin.job.retry', {
      user: admin,
      detail: JSON.stringify({ jobId }),
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('重试任务失败:', err);
    return NextResponse.json({ error: '操作失败' }, { status: 500 });
  }
}

// 批量清理已完成 / 失败任务
export async function DELETE(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:jobs:cleanup',
    limit: 10,
    windowMs: 60_000,
  });
  if (response) return response;

  // 用 query string 而非 body — 与 preview 入参共享一套形式，且避免被
  // 误触发的 prefetch / curl 顺手就把 body 丢进来。
  const { searchParams } = new URL(req.url);
  const validation = validateJobCleanupParams({
    statuses: searchParams.getAll('statuses'),
    olderThanDays: Number(searchParams.get('olderThanDays')),
    type: searchParams.get('type') || undefined,
  });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const cutoff = olderThanDaysToCutoff(validation.olderThanDays);
    const result = await prisma.jobQueue.deleteMany({
      where: {
        status: { in: validation.statuses },
        createdAt: { lt: cutoff },
        ...(validation.type ? { type: validation.type } : {}),
      },
    });

    logAction(req, 'admin.job.cleanup', {
      user: admin,
      detail: JSON.stringify({
        statuses: validation.statuses,
        olderThanDays: validation.olderThanDays,
        type: validation.type,
        deletedCount: result.count,
      }),
    });

    return NextResponse.json({ success: true, deletedCount: result.count });
  } catch (err) {
    console.error('清理任务队列失败:', err);
    return NextResponse.json({ error: '清理失败' }, { status: 500 });
  }
}
