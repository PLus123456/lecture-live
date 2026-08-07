import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { logAction } from '@/lib/auditLog';
import { getQuotaCycleStartAt } from '@/lib/billing';

/**
 * P5-1(c)：修复的有效性下界 = max(配额周期起点, transcriptionUsageReconcileFrom)。
 *
 * 只看 cycleStart 是不够的：settlePoolOnLimitChangeTx 把 quotaResetAt 推到**下月 1 日**，而
 * getQuotaCycleStartAt(下月1日) 仍等于本月 1 日 —— 与结算前一模一样，守卫必然放行，于是已被
 * 池结清（used 已归零）的分钟被这里原样写回 used，下次月度重置再从 gross 池扣一遍（二次扣池）。
 * PR#219 把这个下界补进了计算侧（quota.ts reconcileTranscriptionUsage），修复侧当时漏了。
 */
function fixLowerBound(user: {
  quotaResetAt: Date | null;
  transcriptionUsageReconcileFrom: Date | null;
}): Date {
  const cycleStart = getQuotaCycleStartAt(user.quotaResetAt);
  return user.transcriptionUsageReconcileFrom &&
    user.transcriptionUsageReconcileFrom > cycleStart
    ? user.transcriptionUsageReconcileFrom
    : cycleStart;
}

/** 修复被并发抢先/快照失效时抛出，用于回滚整个修复事务（Prisma 交互式事务遇异常整体回滚）。 */
class FixConflictError extends Error {
  constructor(public readonly reason: 'stale' | 'raced') {
    super(reason);
  }
}

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
      // P5-1(c)：下界还要取 transcriptionUsageReconcileFrom（见 fixLowerBound）。
      const affectedUserIds = [...new Set(unfixed.map((m) => m.userId))];
      const affectedUsers = await prisma.user.findMany({
        where: { id: { in: affectedUserIds } },
        select: {
          id: true,
          quotaResetAt: true,
          transcriptionUsageReconcileFrom: true,
        },
      });
      const lowerBoundByUser = new Map(
        affectedUsers.map((u) => [u.id, fixLowerBound(u)])
      );
      const applicable = unfixed.filter((m) => {
        const lowerBound = lowerBoundByUser.get(m.userId);
        // 用户已不存在，或 run 早于其有效性下界 → 陈旧，跳过
        return lowerBound !== undefined && run.createdAt >= lowerBound;
      });

      if (applicable.length === 0) {
        return NextResponse.json(
          { error: '该对账运行已跨越用户当前配额周期，快照用量已过期，不能修复' },
          { status: 409 }
        );
      }

      // 在**一个**事务中批量修复（仅当期适用项）+ 标记 + 计数递增，保证一致。
      // P5-1(a)：写回改「CAS + 增量」——WHERE transcriptionMinutesUsed = 快照 storedMinutes，
      // data 用 increment: driftMinutes。绝对写（= recordedMinutes）会把 run 之后发生的所有真实
      // 扣费一笔抹掉（陈旧快照覆盖）；CAS 让用量在 run 之后变动过的用户直接跳过、不误改。
      const { appliedIds, staleIds } = await prisma.$transaction(async (tx) => {
        const applied: string[] = [];
        const stale: string[] = [];
        for (const m of applicable) {
          const cas = await tx.user.updateMany({
            where: { id: m.userId, transcriptionMinutesUsed: m.storedMinutes },
            data: { transcriptionMinutesUsed: { increment: m.driftMinutes } },
          });
          if (cas.count === 1) applied.push(m.id);
          else stale.push(m.id);
        }
        if (applied.length > 0) {
          // fixed:false 谓词：并发的另一次修复已标记过则不重复计数（fixedCount 不虚高）。
          const marked = await tx.reconciliationMismatch.updateMany({
            where: { id: { in: applied }, fixed: false },
            data: { fixed: true, fixedAt: new Date(), fixedBy: user.id },
          });
          await tx.reconciliationRun.update({
            where: { id: runId },
            data: { fixedCount: { increment: marked.count } },
          });
        }
        return { appliedIds: applied, staleIds: stale };
      });

      logAction(req, 'admin.reconciliation.fixAll', {
        user,
        detail: JSON.stringify({
          runId,
          fixedCount: appliedIds.length,
          skippedStale: unfixed.length - applicable.length + staleIds.length,
        }),
      });

      return NextResponse.json({
        message: '批量修复完成',
        fixedCount: appliedIds.length,
        skippedStale: unfixed.length - applicable.length + staleIds.length,
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
      select: {
        id: true,
        quotaResetAt: true,
        transcriptionUsageReconcileFrom: true,
      },
    });
    if (!targetUser) {
      return NextResponse.json({ error: '目标用户不存在' }, { status: 404 });
    }
    if (mismatch.run.createdAt < fixLowerBound(targetUser)) {
      return NextResponse.json(
        { error: '该对账运行已跨越用户当前配额周期，快照用量已过期，不能修复' },
        { status: 409 }
      );
    }

    // P5-10：三步（改用量 / 标记已修 / 递增计数）此前是三次独立提交——任一步失败都留下
    // 「钱改了但没标记」或「标记了但计数没动」的半截状态，重试还会再改一次用量。包进一个事务。
    // P5-1(a)：写回同样改 CAS + increment driftMinutes（见批量分支注释）。
    try {
      await prisma.$transaction(async (tx) => {
        // 先抢标记（fixed:false 谓词）：并发的第二个请求在此拿到 count=0 → 抛错整体回滚，
        // 不会出现「两个请求各改一次用量、fixedCount 加两次」。
        const marked = await tx.reconciliationMismatch.updateMany({
          where: { id: mismatchId, fixed: false },
          data: { fixed: true, fixedAt: new Date(), fixedBy: user.id },
        });
        if (marked.count !== 1) throw new FixConflictError('raced');

        const cas = await tx.user.updateMany({
          where: {
            id: mismatch.userId,
            transcriptionMinutesUsed: mismatch.storedMinutes,
          },
          data: { transcriptionMinutesUsed: { increment: mismatch.driftMinutes } },
        });
        if (cas.count !== 1) throw new FixConflictError('stale');

        await tx.reconciliationRun.update({
          where: { id: mismatch.runId },
          data: { fixedCount: { increment: 1 } },
        });
      });
    } catch (txErr) {
      if (txErr instanceof FixConflictError) {
        return NextResponse.json(
          {
            error:
              txErr.reason === 'raced'
                ? '该差异已被其他管理员修复'
                : '该用户用量在本次对账之后已变化，快照已过期；请重新运行对账后再修复',
          },
          { status: 409 }
        );
      }
      throw txErr;
    }

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
