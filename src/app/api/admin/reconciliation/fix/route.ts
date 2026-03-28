import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { logAction } from '@/lib/auditLog';

// 修复对账差异
export async function POST(req: Request) {
  const { user, response } = await requireAdminAccess(req, {
    scope: 'admin:reconciliation:fix',
    limit: 30,
  });
  if (response || !user) return response!;

  try {
    const body = await req.json();
    const { mismatchId, runId, fixAll } = body as {
      mismatchId?: string;
      runId?: string;
      fixAll?: boolean;
    };

    // 批量修复：修复某次运行中所有未修复的差异
    if (fixAll && runId) {
      const unfixed = await prisma.reconciliationMismatch.findMany({
        where: { runId, fixed: false },
      });

      if (unfixed.length === 0) {
        return NextResponse.json({ message: '无需修复', fixedCount: 0 });
      }

      // 在事务中批量修复
      await prisma.$transaction(
        unfixed.map((m) =>
          prisma.user.update({
            where: { id: m.userId },
            data: { transcriptionMinutesUsed: m.recordedMinutes },
          })
        )
      );

      // 标记差异为已修复
      await prisma.reconciliationMismatch.updateMany({
        where: { runId, fixed: false },
        data: {
          fixed: true,
          fixedAt: new Date(),
          fixedBy: user.id,
        },
      });

      // 更新运行记录的已修复计数
      await prisma.reconciliationRun.update({
        where: { id: runId },
        data: { fixedCount: { increment: unfixed.length } },
      });

      logAction(req, 'admin.reconciliation.fixAll', {
        user,
        detail: JSON.stringify({ runId, fixedCount: unfixed.length }),
      });

      return NextResponse.json({ message: '批量修复完成', fixedCount: unfixed.length });
    }

    // 单条修复
    if (!mismatchId) {
      return NextResponse.json({ error: '缺少 mismatchId 参数' }, { status: 400 });
    }

    const mismatch = await prisma.reconciliationMismatch.findUnique({
      where: { id: mismatchId },
    });

    if (!mismatch) {
      return NextResponse.json({ error: '差异记录不存在' }, { status: 404 });
    }

    if (mismatch.fixed) {
      return NextResponse.json({ error: '该差异已修复' }, { status: 400 });
    }

    // 修正用户的配额用量为实际计算值
    await prisma.user.update({
      where: { id: mismatch.userId },
      data: { transcriptionMinutesUsed: mismatch.recordedMinutes },
    });

    // 标记差异为已修复
    await prisma.reconciliationMismatch.update({
      where: { id: mismatchId },
      data: {
        fixed: true,
        fixedAt: new Date(),
        fixedBy: user.id,
      },
    });

    // 更新运行记录的已修复计数
    await prisma.reconciliationRun.update({
      where: { id: mismatch.runId },
      data: { fixedCount: { increment: 1 } },
    });

    logAction(req, 'admin.reconciliation.fix', {
      user,
      detail: JSON.stringify({
        mismatchId,
        userId: mismatch.userId,
        from: mismatch.storedMinutes,
        to: mismatch.recordedMinutes,
      }),
    });

    return NextResponse.json({ message: '修复成功' });
  } catch (err) {
    console.error('修复对账差异失败:', err);
    return NextResponse.json({ error: '修复失败' }, { status: 500 });
  }
}
