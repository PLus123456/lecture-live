import type {
  Prisma,
  ReconciliationMismatch,
  ReconciliationRun,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { reconcileTranscriptionUsage } from '@/lib/quota';
import { getSiteSettings } from '@/lib/siteSettings';
import { logSystemEvent } from '@/lib/auditLog';

interface RunTranscriptionUsageReconciliationOptions {
  triggeredBy: string;
  triggeredByName?: string | null;
  source?: 'admin' | 'scheduler' | 'manual';
  completionMutation?: (
    tx: Prisma.TransactionClient,
    run: ReconciliationRun & { mismatches: ReconciliationMismatch[] }
  ) => Promise<void>;
  failureMutation?: (
    tx: Prisma.TransactionClient,
    failure: { runId: string; errorMessage: string }
  ) => Promise<void>;
}

export async function runTranscriptionUsageReconciliation(
  options: RunTranscriptionUsageReconciliationOptions
) {
  const run = await prisma.reconciliationRun.create({
    data: {
      triggeredBy: options.triggeredBy,
      triggeredByName: options.triggeredByName ?? null,
      status: 'running',
    },
  });

  try {
    // 异步上传转录按可配置倍率计费，对账须乘同样倍率（口径一致，避免恒报 drift）
    const { async_upload_billing_multiplier } = await getSiteSettings();
    const mismatches = await reconcileTranscriptionUsage(async_upload_billing_multiplier);
    const totalUsers = await prisma.user.count();

    const completedRun = await prisma.$transaction(async (tx) => {
      if (mismatches.length > 0) {
        await tx.reconciliationMismatch.createMany({
          data: mismatches.map((mismatch) => ({
            runId: run.id,
            userId: mismatch.id,
            userEmail: mismatch.email,
            recordedMinutes: mismatch.recordedMinutes,
            storedMinutes: mismatch.transcriptionMinutesUsed,
            driftMinutes: mismatch.driftMinutes,
          })),
        });
      }

      const completed = await tx.reconciliationRun.update({
        where: { id: run.id },
        data: {
          status: 'completed',
          totalUsers,
          mismatchCount: mismatches.length,
          completedAt: new Date(),
        },
        include: {
          mismatches: {
            orderBy: { driftMinutes: 'desc' },
          },
        },
      });
      await options.completionMutation?.(tx, completed);
      return completed;
    });

    if (options.source !== 'admin') {
      logSystemEvent(
        'billing.reconciliation.completed',
        JSON.stringify({
          runId: completedRun.id,
          source: options.source ?? 'manual',
          totalUsers,
          mismatchCount: mismatches.length,
        })
      );
    }

    return completedRun;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    try {
      await prisma.$transaction(async (tx) => {
        await tx.reconciliationRun.update({
          where: { id: run.id },
          data: {
            status: 'failed',
            errorMessage,
            completedAt: new Date(),
          },
        });
        await options.failureMutation?.(tx, { runId: run.id, errorMessage });
      });
    } catch (terminalError) {
      throw new AggregateError(
        [error, terminalError],
        `Reconciliation ${run.id} failed and its terminal state could not be persisted`
      );
    }

    if (options.source !== 'admin') {
      logSystemEvent(
        'billing.reconciliation.failed',
        JSON.stringify({
          runId: run.id,
          source: options.source ?? 'manual',
          error: errorMessage,
        })
      );
    }

    throw error;
  }
}
