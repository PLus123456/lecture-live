import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import {
  queryJobs,
  retryJob,
  isJobTypeRetryable,
  JOB_TYPE,
  JOB_STATUS,
} from '@/lib/jobQueue';
import {
  validateJobCleanupParams,
  olderThanDaysToCutoff,
} from '@/lib/adminCleanup';
import {
  getSecurityAuditRequestId,
  writeSecurityAudit,
} from '@/lib/securityAudit';

const VALID_TYPES = new Set(Object.values(JOB_TYPE));
const VALID_STATUSES = new Set(Object.values(JOB_STATUS));

function auditOperator(admin: {
  id: string;
  email?: string | null;
  role?: string | null;
}) {
  return {
    id: admin.id,
    email: admin.email ?? null,
    role: admin.role ?? null,
  };
}

const JOB_AUDIT_SELECT = {
  id: true,
  type: true,
  status: true,
  userId: true,
  sessionId: true,
  attempt: true,
  maxAttempts: true,
} as const;

// 获取任务队列（分页 + 筛选） / 清理预览
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  // ─── 清理预览：返回 count 不实际删 ───
  if (searchParams.get('cleanup_preview') === '1') {
    const { user: admin, response } = await requireAdminAccess(req, {
      scope: 'admin:jobs:cleanup:preview',
      limit: 30,
      windowMs: 60_000,
    });
    if (response) return response;
    if (!admin) return NextResponse.json({ error: '权限不足' }, { status: 403 });

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
          // LLM 日账按终态时间结算。老任务今天才由僵尸回收落终态时，不能因
          // createdAt 很旧而立刻删除并释放今天的保守 actualUnits。
          completedAt: { lt: cutoff },
          // actualUnits=NULL 的资源终态表示 provider 可能已调用、但结算不可
          // 证明。它是 owner 终身预算的保守账本，通用 cleanup 不得删除后
          // 重新发放额度。
          OR: [{ resourceScope: null }, { actualUnits: { not: null } }],
          ...(validation.type ? { type: validation.type } : {}),
        },
      });
      await writeSecurityAudit(req, {
        event: 'jobs.cleanup_preview',
        operator: auditOperator(admin),
        target: { type: 'job_queue_collection' },
        before: null,
        after: { eligibleCount: count },
        reason: 'admin_cleanup_preview',
        outcome: 'SUCCESS',
        metadata: {
          statuses: validation.statuses,
          olderThanDays: validation.olderThanDays,
          type: validation.type ?? null,
        },
        requestId: getSecurityAuditRequestId(req),
      });
      return NextResponse.json({ count });
    } catch (err) {
      console.error('查询任务清理预览失败:', err);
      return NextResponse.json({ error: '查询失败' }, { status: 500 });
    }
  }

  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:jobs:list',
    limit: 60,
  });
  if (response) return response;
  if (!admin) return NextResponse.json({ error: '权限不足' }, { status: 403 });

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
    await writeSecurityAudit(req, {
      event: 'jobs.read',
      operator: auditOperator(admin),
      target: { type: 'job_queue_collection' },
      before: null,
      after: {
        resultCount: result.jobs.length,
        total: result.pagination.total,
        page: result.pagination.page,
        pageSize: result.pagination.pageSize,
      },
      reason: 'admin_list',
      outcome: 'SUCCESS',
      metadata: {
        type: type && VALID_TYPES.has(type as never) ? type : null,
        status: status && VALID_STATUSES.has(status as never) ? status : null,
      },
      requestId: getSecurityAuditRequestId(req),
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
  if (!admin) return NextResponse.json({ error: '权限不足' }, { status: 403 });

  try {
    const body = await req.json();
    const { jobId } = body as { jobId?: string };

    if (!jobId || typeof jobId !== 'string') {
      return NextResponse.json({ error: '缺少 jobId' }, { status: 400 });
    }

    const requestId = getSecurityAuditRequestId(req);
    const retryResult = await prisma.$transaction(async (tx) => {
      const before = await tx.jobQueue.findUnique({
        where: { id: jobId },
        select: JOB_AUDIT_SELECT,
      });
      const ok = await retryJob(jobId, tx);
      const after = ok
        ? await tx.jobQueue.findUnique({
            where: { id: jobId },
            select: JOB_AUDIT_SELECT,
          })
        : before;

      await writeSecurityAudit(
        req,
        {
          event: 'jobs.retry',
          operator: auditOperator(admin),
          target: {
            type: 'job_queue_item',
            id: jobId,
            ownerId: before?.userId ?? null,
          },
          before,
          after,
          reason: 'admin_retry',
          outcome: ok ? 'SUCCESS' : 'DENIED',
          metadata: {
            retryableType: before ? isJobTypeRetryable(before.type) : null,
          },
          requestId,
        },
        tx
      );

      return { ok, type: before?.type ?? null };
    });

    if (!retryResult.ok) {
      // L10/P5-16：retryJob 现在还会为「该类型没有消费者」和「同会话已有活跃任务占着 activeKey」
      // 返回 false。都用同一句「未失败或已达上限」会把管理员引到错误的排查方向，所以先按类型分流。
      const message =
        retryResult.type && !isJobTypeRetryable(retryResult.type)
          ? `无法重试：任务类型 ${retryResult.type} 由系统自动调度，没有可重投的消费者`
          : '无法重试：任务不存在、未失败、已达最大重试次数，或同会话已有进行中的同类任务';
      return NextResponse.json({ error: message }, { status: 409 });
    }

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
  if (!admin) return NextResponse.json({ error: '权限不足' }, { status: 403 });

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
    const requestId = getSecurityAuditRequestId(req);
    const result = await prisma.$transaction(async (tx) => {
      const deleted = await tx.jobQueue.deleteMany({
        where: {
          status: { in: validation.statuses },
          completedAt: { lt: cutoff },
          OR: [{ resourceScope: null }, { actualUnits: { not: null } }],
          ...(validation.type ? { type: validation.type } : {}),
        },
      });

      await writeSecurityAudit(
        req,
        {
          event: 'jobs.cleanup',
          operator: auditOperator(admin),
          target: { type: 'job_queue_collection' },
          before: { eligibleCount: deleted.count },
          after: { deletedCount: deleted.count },
          reason: 'admin_cleanup',
          outcome: 'SUCCESS',
          metadata: {
            statuses: validation.statuses,
            olderThanDays: validation.olderThanDays,
            type: validation.type ?? null,
          },
          requestId,
        },
        tx
      );

      return deleted;
    });

    return NextResponse.json({ success: true, deletedCount: result.count });
  } catch (err) {
    console.error('清理任务队列失败:', err);
    return NextResponse.json({ error: '清理失败' }, { status: 500 });
  }
}
