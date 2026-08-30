import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { migrateLocalToCloudreve } from '@/lib/storage/migration';
import { trackJob, JOB_TYPE } from '@/lib/jobQueue';
import { writeSecurityAudit } from '@/lib/securityAudit';

// 手动触发本地 → Cloudreve 迁移
export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:storage:migrate',
    limit: 3,
    windowMs: 10 * 60_000,
  });
  if (response || !admin) return response!;

  try {
    const result = await trackJob(
      {
        type: JOB_TYPE.STORAGE_MIGRATION,
        triggeredBy: `admin:${admin.id}`,
        params: { direction: 'local_to_cloudreve' },
        resultSummary: (value) => ({
          migratedCount: value.migratedCount,
          skippedCount: value.skippedCount,
          errorCount: value.errorCount,
        }),
        errorSummary: (error) =>
          error instanceof Error ? error.name : 'UnknownError',
        terminalMutation: async (tx, terminal) => {
          const completed = terminal.status === 'SUCCESS' ? terminal.result : null;
          const errorClass =
            terminal.status === 'FAILED'
              ? terminal.error instanceof Error
                ? terminal.error.name
                : 'UnknownError'
              : undefined;
          await writeSecurityAudit(
            req,
            {
              event: 'storage.migrate',
              operator: { id: admin.id, email: admin.email, role: admin.role },
              target: { type: 'storage_backend', id: 'global' },
              before: { backend: 'local' },
              after: completed
                ? {
                    backend: 'cloudreve',
                    migratedCount: completed.migratedCount,
                    skippedCount: completed.skippedCount,
                    errorCount: completed.errorCount,
                  }
                : undefined,
              reason: 'admin_manual_migration',
              outcome: !completed
                ? 'FAILED'
                : completed.errorCount > 0
                  ? 'PARTIAL'
                  : 'SUCCESS',
              metadata: completed
                ? undefined
                : { errorClass: errorClass ?? 'UnknownError' },
            },
            tx
          );
        },
      },
      () => migrateLocalToCloudreve(),
    );
    return NextResponse.json(result);
  } catch (err) {
    console.error('存储迁移失败:', err);
    return NextResponse.json({ error: '迁移失败' }, { status: 500 });
  }
}
