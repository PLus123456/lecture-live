import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { runTranscriptionUsageReconciliation } from '@/lib/reconciliation';
import { withRequestLogging } from '@/lib/requestLogger';
import { writeSecurityAudit } from '@/lib/securityAudit';

// 获取对账历史（分页）
export const GET = withRequestLogging(
  'admin:reconciliation:list',
  async (req: Request) => {
    const { user, response } = await requireAdminAccess(req, {
      scope: 'admin:reconciliation:list',
      limit: 60,
    });
    if (response || !user) return response!;

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));

    try {
      const [runs, total] = await Promise.all([
        prisma.reconciliationRun.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            _count: { select: { mismatches: true } },
          },
        }),
        prisma.reconciliationRun.count(),
      ]);

      await writeSecurityAudit(req, {
        event: 'reconciliation.read',
        operator: user,
        target: { type: 'reconciliation_run_collection' },
        before: null,
        after: null,
        reason: 'admin-reconciliation-history-read',
        outcome: 'SUCCESS',
        metadata: { page, pageSize, resultCount: runs.length, total },
      });

      return NextResponse.json({
        runs,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
      });
    } catch (err) {
      console.error('查询对账记录失败:', err);
      return NextResponse.json({ error: '查询失败' }, { status: 500 });
    }
  }
);

// 触发新的对账运行
export const POST = withRequestLogging(
  'admin:reconciliation:trigger',
  async (req: Request) => {
    const { user, response } = await requireAdminAccess(req, {
      scope: 'admin:reconciliation:trigger',
      limit: 5,
    });
    if (response || !user) return response!;

    try {
      const completedRun = await runTranscriptionUsageReconciliation({
        triggeredBy: user.id,
        triggeredByName: user.email,
        source: 'admin',
        completionMutation: async (tx, run) => {
          await writeSecurityAudit(
            req,
            {
              event: 'reconciliation.run',
              operator: user,
              target: { type: 'reconciliation_run', id: run.id },
              before: { status: 'running' },
              after: {
                status: 'completed',
                totalUsers: run.totalUsers,
                mismatchCount: run.mismatchCount,
              },
              reason: 'admin-requested-transcription-reconciliation',
              outcome: 'SUCCESS',
              metadata: { durableRun: true },
            },
            tx
          );
        },
        failureMutation: async (tx, failure) => {
          await writeSecurityAudit(
            req,
            {
              event: 'reconciliation.run',
              operator: user,
              target: { type: 'reconciliation_run', id: failure.runId },
              before: { status: 'running' },
              after: { status: 'failed' },
              reason: 'admin-requested-transcription-reconciliation',
              outcome: 'FAILED',
              metadata: { durableRun: true },
            },
            tx
          );
        },
      });

      return NextResponse.json(completedRun);
    } catch (err) {
      console.error('对账运行失败:', err);
      return NextResponse.json({ error: '对账运行失败' }, { status: 500 });
    }
  }
);
