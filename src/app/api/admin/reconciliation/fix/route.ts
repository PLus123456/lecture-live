import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { logAction } from '@/lib/auditLog';
import { getQuotaCycleStartAt } from '@/lib/billing';

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
      const run = await prisma.reconciliationRun.findUnique({
        where: { id: runId },
        select: { id: true, createdAt: true },
      });
      if (!run) {
        return NextResponse.json({ error: '对账运行记录不存在' }, { status: 404 });
      }

      const unfixed = await prisma.reconciliationMismatch.findMany({
        where: { runId, fixed: false },
      });

      if (unfixed.length === 0) {
        return NextResponse.json({ message: '无需修复', fixedCount: 0 });
      }

      // U45：recordedMinutes 是 run 创建时按当期快照的当期绝对用量。若 run 早于用户当前
      // 配额周期起点（周期已滚动、计数器可能已月度重置），用旧快照覆写会造成用量倒灌/清零。
      // 逐用户按其 quotaResetAt 判定：run 属于用户上一周期则跳过（不修）。
      const affectedUserIds = [...new Set(unfixed.map((m) => m.userId))];
      const affectedUsers = await prisma.user.findMany({
        where: { id: { in: affectedUserIds } },
        select: { id: true, quotaResetAt: true },
      });
      const cycleStartByUser = new Map(
        affectedUsers.map((u) => [u.id, getQuotaCycleStartAt(u.quotaResetAt)])
      );
      const applicable = unfixed.filter((m) => {
        const cycleStart = cycleStartByUser.get(m.userId);
        // 用户已不存在，或 run 早于其当前周期起点 → 陈旧，跳过
        return cycleStart !== undefined && run.createdAt >= cycleStart;
      });

      if (applicable.length === 0) {
        return NextResponse.json(
          { error: '该对账运行已跨越用户当前配额周期，快照用量已过期，不能修复' },
          { status: 409 }
        );
      }

      const applicableIds = applicable.map((m) => m.id);

      // 在事务中批量修复（仅当期适用项）+ 标记 + 计数递增，保证一致
      await prisma.$transaction([
        ...applicable.map((m) =>
          prisma.user.update({
            where: { id: m.userId },
            data: { transcriptionMinutesUsed: m.recordedMinutes },
          })
        ),
        prisma.reconciliationMismatch.updateMany({
          where: { id: { in: applicableIds } },
          data: {
            fixed: true,
            fixedAt: new Date(),
            fixedBy: user.id,
          },
        }),
        prisma.reconciliationRun.update({
          where: { id: runId },
          data: { fixedCount: { increment: applicable.length } },
        }),
      ]);

      logAction(req, 'admin.reconciliation.fixAll', {
        user,
        detail: JSON.stringify({
          runId,
          fixedCount: applicable.length,
          skippedStale: unfixed.length - applicable.length,
        }),
      });

      return NextResponse.json({
        message: '批量修复完成',
        fixedCount: applicable.length,
        skippedStale: unfixed.length - applicable.length,
      });
    }

    // 单条修复
    if (!mismatchId) {
      return NextResponse.json({ error: '缺少 mismatchId 参数' }, { status: 400 });
    }

    const mismatch = await prisma.reconciliationMismatch.findUnique({
      where: { id: mismatchId },
      include: { run: { select: { createdAt: true } } },
    });

    if (!mismatch) {
      return NextResponse.json({ error: '差异记录不存在' }, { status: 404 });
    }

    if (mismatch.fixed) {
      return NextResponse.json({ error: '该差异已修复' }, { status: 400 });
    }

    // U45：跨周期陈旧校验——recordedMinutes 是 run 创建时的当期绝对用量快照，若该 run
    // 早于用户当前配额周期起点（周期已滚动/月度重置），覆写会造成用量倒灌或清零，拒绝修复。
    const targetUser = await prisma.user.findUnique({
      where: { id: mismatch.userId },
      select: { id: true, quotaResetAt: true },
    });
    if (!targetUser) {
      return NextResponse.json({ error: '目标用户不存在' }, { status: 404 });
    }
    const cycleStart = getQuotaCycleStartAt(targetUser.quotaResetAt);
    if (mismatch.run.createdAt < cycleStart) {
      return NextResponse.json(
        { error: '该对账运行已跨越用户当前配额周期，快照用量已过期，不能修复' },
        { status: 409 }
      );
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
