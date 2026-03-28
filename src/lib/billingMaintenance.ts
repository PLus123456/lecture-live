import { prisma } from '@/lib/prisma';
import { logSystemEvent } from '@/lib/auditLog';
import { logger, serializeError } from '@/lib/logger';
import {
  loadRecordingDraftManifest,
} from '@/lib/recordingDraftPersistence';
import {
  loadTranscriptDraftManifest,
} from '@/lib/transcriptDraftPersistence';
import {
  resetExpiredTranscriptionQuotas,
} from '@/lib/quota';
import { runTranscriptionUsageReconciliation } from '@/lib/reconciliation';
import { finalizeSession } from '@/lib/sessionFinalization';

const STALE_SESSION_THRESHOLD_MS = 4 * 60 * 60_000;
const MAINTENANCE_INTERVAL_MS = 15 * 60_000;
const RECONCILIATION_LAST_RUN_KEY = 'billing.reconciliation.lastRunUtcDate';
const billingLogger = logger.child({ component: 'billing-maintenance' });

type BillingMaintenanceGlobal = typeof globalThis & {
  __lectureLiveBillingMaintenanceStarted?: boolean;
  __lectureLiveBillingMaintenanceTimer?: ReturnType<typeof setInterval>;
  __lectureLiveBillingMaintenanceRun?: Promise<void> | null;
};

export interface BillingMaintenanceSummary {
  resetUsers: number;
  reclaimedSessions: number;
  reconciliationRunId: string | null;
}

export function startBillingMaintenanceLoop(
  intervalMs = MAINTENANCE_INTERVAL_MS
) {
  const globalState = globalThis as BillingMaintenanceGlobal;
  if (globalState.__lectureLiveBillingMaintenanceStarted) {
    return;
  }

  globalState.__lectureLiveBillingMaintenanceStarted = true;

  const triggerRun = () => {
    if (globalState.__lectureLiveBillingMaintenanceRun) {
      return;
    }

    const runPromise = runBillingMaintenance({ source: 'scheduler' })
      .catch((error) => {
        billingLogger.error(
          { err: serializeError(error) },
          'Billing maintenance failed'
        );
        logSystemEvent(
          'billing.maintenance.failed',
          JSON.stringify({
            source: 'scheduler',
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        );
      })
      .finally(() => {
        globalState.__lectureLiveBillingMaintenanceRun = null;
      });

    globalState.__lectureLiveBillingMaintenanceRun = runPromise.then(
      () => undefined
    );
  };

  triggerRun();

  const timer = setInterval(triggerRun, intervalMs);
  timer.unref?.();
  globalState.__lectureLiveBillingMaintenanceTimer = timer;
}

export function stopBillingMaintenanceLoop() {
  const globalState = globalThis as BillingMaintenanceGlobal;
  const timer = globalState.__lectureLiveBillingMaintenanceTimer;
  if (timer) {
    clearInterval(timer);
    globalState.__lectureLiveBillingMaintenanceTimer = undefined;
  }
  globalState.__lectureLiveBillingMaintenanceStarted = false;
  globalState.__lectureLiveBillingMaintenanceRun = null;
}

export async function runBillingMaintenance(options?: {
  now?: Date;
  source?: 'scheduler' | 'manual';
}): Promise<BillingMaintenanceSummary> {
  const now = options?.now ?? new Date();
  const resetUsers = await resetExpiredTranscriptionQuotas(now);
  const reclaimedSessions = await reclaimStaleSessions(now);
  const reconciliationRunId = await maybeRunDailyReconciliation(now);

  if (resetUsers > 0 || reclaimedSessions > 0 || reconciliationRunId) {
    logSystemEvent(
      'billing.maintenance.completed',
      JSON.stringify({
        source: options?.source ?? 'manual',
        resetUsers,
        reclaimedSessions,
        reconciliationRunId,
      })
    );
  }

  return {
    resetUsers,
    reclaimedSessions,
    reconciliationRunId,
  };
}

async function reclaimStaleSessions(now: Date): Promise<number> {
  const candidates = await prisma.session.findMany({
    where: {
      status: { in: ['RECORDING', 'PAUSED', 'FINALIZING'] },
      OR: [
        { updatedAt: { lte: new Date(now.getTime() - STALE_SESSION_THRESHOLD_MS) } },
        { serverStartedAt: { lte: new Date(now.getTime() - STALE_SESSION_THRESHOLD_MS) } },
      ],
    },
    select: {
      id: true,
      userId: true,
      updatedAt: true,
    },
    take: 100,
    orderBy: { updatedAt: 'asc' },
  });

  let reclaimedCount = 0;

  for (const session of candidates) {
    const isStale = await isSessionStale(session, now);
    if (!isStale) {
      continue;
    }

    try {
      const result = await finalizeSession({
        sessionId: session.id,
        actor: null,
        allowStatusPromotion: true,
        finalizeSource: 'system_auto_reclaim',
      });

      if (!result.alreadyCompleted) {
        reclaimedCount += 1;
      }
    } catch (error) {
      billingLogger.error(
        {
          sessionId: session.id,
          userId: session.userId,
          err: serializeError(error),
        },
        'Auto reclaim failed'
      );
      logSystemEvent(
        'billing.auto_reclaim.failed',
        JSON.stringify({
          sessionId: session.id,
          userId: session.userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      );
    }
  }

  return reclaimedCount;
}

async function isSessionStale(
  session: {
    id: string;
    userId: string;
    updatedAt: Date;
  },
  now: Date
): Promise<boolean> {
  const [recordingDraft, transcriptDraft] = await Promise.all([
    loadRecordingDraftManifest(session),
    loadTranscriptDraftManifest(session),
  ]);

  const lastActivityMs = Math.max(
    session.updatedAt.getTime(),
    recordingDraft?.updatedAt ?? 0,
    transcriptDraft?.updatedAt ?? 0
  );

  return now.getTime() - lastActivityMs >= STALE_SESSION_THRESHOLD_MS;
}

async function maybeRunDailyReconciliation(now: Date): Promise<string | null> {
  const todayUtc = now.toISOString().slice(0, 10);
  const lastRun = await prisma.siteSetting.findUnique({
    where: { key: RECONCILIATION_LAST_RUN_KEY },
    select: { value: true },
  });

  if (lastRun?.value === todayUtc) {
    return null;
  }

  const run = await runTranscriptionUsageReconciliation({
    triggeredBy: 'system',
    triggeredByName: 'Billing Maintenance',
    source: 'scheduler',
  });

  await prisma.siteSetting.upsert({
    where: { key: RECONCILIATION_LAST_RUN_KEY },
    create: { key: RECONCILIATION_LAST_RUN_KEY, value: todayUtc },
    update: { value: todayUtc },
  });

  return run.id;
}
