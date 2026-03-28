import { prisma } from '@/lib/prisma';
import { reconcileTranscriptionUsage } from '@/lib/quota';
import { logSystemEvent } from '@/lib/auditLog';

interface RunTranscriptionUsageReconciliationOptions {
  triggeredBy: string;
  triggeredByName?: string | null;
  source?: 'admin' | 'scheduler' | 'manual';
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
    const mismatches = await reconcileTranscriptionUsage();
    const totalUsers = await prisma.user.count();

    if (mismatches.length > 0) {
      await prisma.reconciliationMismatch.createMany({
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

    const completedRun = await prisma.reconciliationRun.update({
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
    await prisma.reconciliationRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        completedAt: new Date(),
      },
    }).catch(() => undefined);

    if (options.source !== 'admin') {
      logSystemEvent(
        'billing.reconciliation.failed',
        JSON.stringify({
          runId: run.id,
          source: options.source ?? 'manual',
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      );
    }

    throw error;
  }
}
