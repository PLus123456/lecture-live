import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { getQuotaCycleStartAt } from '@/lib/billing';
import { getSiteSettings } from '@/lib/siteSettings';
import { writeSecurityAudit } from '@/lib/securityAudit';
import {
  calculateTranscriptionUsageReconciliation,
  type QuotaDbClient,
} from '@/lib/quota';

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

type LockedReconciliationUser = {
  id: string;
  email: string;
  transcriptionMinutesUsed: number;
  quotaResetAt: Date | null;
  transcriptionUsageReconcileFrom: Date | null;
};

type RepairCandidate = {
  id: string;
  runId: string;
  userId: string;
};

type RepairResult =
  | { status: 'applied'; before: number; after: number }
  | {
      status:
        | 'stale'
        | 'raced'
        | 'missing-user'
        | 'expired-run'
        | 'ambiguous-ledger';
    };

/**
 * SEC-030: repair one mismatch against the fresh surviving ledger while the User row is locked.
 * Reservation and settlement paths all update User in their transaction.  Therefore acquiring this
 * lock before the non-locking ledger reads gives us a stable boundary without reversing their
 * Session/Grant -> User lock order (and introducing a deadlock).
 *
 * TranscriptionCharge rows are independent of Session/User lifecycle, so both upward and downward
 * repairs are safe once the current window contains only exact per-charge events. During the
 * one-cycle legacy cutover, an ambiguous opening balance makes every automatic write fail closed.
 */
async function repairMismatchLocked(
  tx: QuotaDbClient,
  mismatch: RepairCandidate,
  runCreatedAt: Date,
  fixedBy: string,
  asyncMultiplier: number
): Promise<RepairResult> {
  const locked = await tx.$queryRaw<LockedReconciliationUser[]>`
    SELECT id, email, transcriptionMinutesUsed, quotaResetAt, transcriptionUsageReconcileFrom
    FROM User
    WHERE id = ${mismatch.userId}
    FOR UPDATE
  `;
  const targetUser = locked[0];
  if (!targetUser) return { status: 'missing-user' };
  if (runCreatedAt < fixLowerBound(targetUser)) return { status: 'expired-run' };

  const current = await calculateTranscriptionUsageReconciliation(
    targetUser,
    asyncMultiplier,
    tx
  );
  if (current.driftMinutes === 0) return { status: 'stale' };
  if (current.hasAmbiguousCharges) return { status: 'ambiguous-ledger' };

  // Claim the mismatch in the same transaction.  If another repair won while we waited for the
  // User lock, rolling the transaction back also rolls back the counter write below.
  const marked = await tx.reconciliationMismatch.updateMany({
    where: { id: mismatch.id, fixed: false },
    data: { fixed: true, fixedAt: new Date(), fixedBy },
  });
  if (marked.count !== 1) return { status: 'raced' };

  await tx.user.update({
    where: { id: targetUser.id },
    data: { transcriptionMinutesUsed: current.recordedMinutes },
  });
  await tx.reconciliationRun.update({
    where: { id: mismatch.runId },
    data: { fixedCount: { increment: 1 } },
  });

  return {
    status: 'applied',
    before: targetUser.transcriptionMinutesUsed,
    after: current.recordedMinutes,
  };
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

      const { async_upload_billing_multiplier: asyncMultiplier } = await getSiteSettings();

      // Stable ordering avoids User-row lock inversion when two bulk repairs overlap.  Each entry is
      // recomputed under its User lock; the historical run snapshot is only an authorization to
      // repair, never the value written back.
      const ordered = [...unfixed].sort(
        (a, b) => a.userId.localeCompare(b.userId) || a.id.localeCompare(b.id)
      );
      const repaired: Array<{
        mismatchId: string;
        userId: string;
        before: number;
        after: number;
      }> = [];
      const skipped: string[] = [];
      const ambiguous: string[] = [];
      for (const mismatch of ordered) {
        // SEC-030: one fresh transaction per user. Under MySQL REPEATABLE READ, the previous
        // implementation's first user's non-locking read fixed one old snapshot for the entire
        // batch. A later User FOR UPDATE was current-read, but Session/grant reads still came from
        // that old snapshot and could resurrect a reservation already released before the lock.
        // Here the User lock is the first statement of each short transaction; every consistent
        // ledger read therefore starts after that lock boundary.
        const result = await prisma.$transaction(async (tx) => {
          const result = await repairMismatchLocked(
            tx,
            mismatch,
            run.createdAt,
            user.id,
            asyncMultiplier
          );
          if (result.status === 'applied') {
            // SEC-033: every independently committed mutation carries its own same-transaction
            // outcome record. A later item/audit failure cannot leave this item unaudited.
            await writeSecurityAudit(
              req,
              {
                event: 'reconciliation.fix-all-item',
                operator: { id: user.id, email: user.email, role: user.role },
                target: {
                  type: 'transcription_usage',
                  id: mismatch.userId,
                  ownerId: mismatch.userId,
                },
                before: { minutes: result.before },
                after: { minutes: result.after },
                reason: 'admin_reconciliation_bulk_fix',
                outcome: 'SUCCESS',
                metadata: { runId, mismatchId: mismatch.id },
              },
              tx
            );
          }
          return result;
        });
        if (result.status === 'applied') {
          repaired.push({
            mismatchId: mismatch.id,
            userId: mismatch.userId,
            before: result.before,
            after: result.after,
          });
        } else if (result.status === 'ambiguous-ledger') {
          ambiguous.push(mismatch.id);
        } else skipped.push(mismatch.id);
      }

      if (repaired.length === 0) {
        if (ambiguous.length > 0) {
          return NextResponse.json(
            {
              error:
                '当前周期包含升级前无法精确分期的历史余额；已拒绝自动改写，请在下一配额周期重新对账',
              code: 'AMBIGUOUS_LEGACY_LEDGER',
              blockedCount: ambiguous.length,
              skippedStale: skipped.length,
            },
            { status: 409 }
          );
        }
        return NextResponse.json(
          { error: '当前用量已变化或快照已过期，请重新运行对账' },
          { status: 409 }
        );
      }

      return NextResponse.json({
        message: '批量修复完成',
        fixedCount: repaired.length,
        skippedStale: skipped.length,
        skippedAmbiguous: ambiguous.length,
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

    const { async_upload_billing_multiplier: asyncMultiplier } = await getSiteSettings();
    const repair = await prisma.$transaction(async (tx) => {
      const result = await repairMismatchLocked(
        tx,
        mismatch,
        mismatch.run.createdAt,
        user.id,
        asyncMultiplier
      );
      if (result.status === 'applied') {
        await writeSecurityAudit(
          req,
          {
            event: 'reconciliation.fix',
            operator: { id: user.id, email: user.email, role: user.role },
            target: {
              type: 'transcription_usage',
              id: mismatch.userId,
              ownerId: mismatch.userId,
            },
            before: { minutes: result.before },
            after: { minutes: result.after },
            reason: 'admin_reconciliation_fix',
            outcome: 'SUCCESS',
            metadata: { mismatchId, runId: mismatch.runId },
          },
          tx
        );
      }
      return result;
    });
    if (repair.status === 'missing-user') {
      return NextResponse.json({ error: '目标用户不存在' }, { status: 404 });
    }
    if (repair.status === 'ambiguous-ledger') {
      return NextResponse.json(
        {
          error:
            '当前周期包含升级前无法精确分期的历史余额；已拒绝自动改写，请在下一配额周期重新对账',
          code: 'AMBIGUOUS_LEGACY_LEDGER',
        },
        { status: 409 }
      );
    }
    if (repair.status !== 'applied') {
      return NextResponse.json(
        {
          error:
            repair.status === 'raced'
              ? '该差异已被其他管理员修复'
              : '当前用量已变化或快照已过期；请重新运行对账后再修复',
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ message: '修复成功' });
  } catch (err) {
    console.error('修复对账差异失败:', err);
    return NextResponse.json({ error: '修复失败' }, { status: 500 });
  }
}
