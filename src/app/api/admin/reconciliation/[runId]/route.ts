import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';

// 获取单次对账运行详情（含差异明细）
export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { response } = await requireAdminAccess(req, {
    scope: 'admin:reconciliation:detail',
    limit: 60,
  });
  if (response) return response;

  const { runId } = await params;

  try {
    const run = await prisma.reconciliationRun.findUnique({
      where: { id: runId },
      include: {
        mismatches: {
          orderBy: { driftMinutes: 'desc' },
        },
      },
    });

    if (!run) {
      return NextResponse.json({ error: '对账记录不存在' }, { status: 404 });
    }

    // P5-1(b)：在途预留会制造**假的负 drift**——reserveTranscriptionMinutes 在入口就把预留计进
    // used，而 reconcileTranscriptionUsage 只统计已 COMPLETED 的用量，于是任何在对账时刻有在途
    // 上传/完整版补全/未结 grant 的用户必被报「多扣了用户」，而面板恰好给这种负 drift 配了
    // 一键/全部修复按钮。把每个用户的在途分钟一并返回，让面板能在按钮旁明确警示。
    const userIds = [...new Set(run.mismatches.map((m) => m.userId))];
    const inflightByUser = new Map<string, number>();
    if (userIds.length > 0) {
      const [sessionAgg, grantAgg] = await Promise.all([
        prisma.session.groupBy({
          by: ['userId'],
          where: { userId: { in: userIds } },
          _sum: { asyncReservedMinutes: true, fullReservedMinutes: true },
        }),
        prisma.sonioxStreamGrant.groupBy({
          by: ['userId'],
          where: { userId: { in: userIds }, settledAt: null },
          _sum: { reservedMinutes: true },
        }),
      ]);
      for (const row of sessionAgg) {
        inflightByUser.set(
          row.userId,
          (inflightByUser.get(row.userId) ?? 0) +
            (row._sum.asyncReservedMinutes ?? 0) +
            (row._sum.fullReservedMinutes ?? 0)
        );
      }
      for (const row of grantAgg) {
        inflightByUser.set(
          row.userId,
          (inflightByUser.get(row.userId) ?? 0) + (row._sum.reservedMinutes ?? 0)
        );
      }
    }

    return NextResponse.json({
      ...run,
      mismatches: run.mismatches.map((m) => ({
        ...m,
        inflightMinutes: inflightByUser.get(m.userId) ?? 0,
      })),
    });
  } catch (err) {
    console.error('查询对账详情失败:', err);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}
