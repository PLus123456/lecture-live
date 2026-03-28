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

    return NextResponse.json(run);
  } catch (err) {
    console.error('查询对账详情失败:', err);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}
