import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { getSiteSettings } from '@/lib/siteSettings';
import { cleanupExpiredLocalFiles } from '@/lib/storage/migration';
import { trackJob, JOB_TYPE } from '@/lib/jobQueue';
import { writeSecurityAudit } from '@/lib/securityAudit';

function auditUnavailable() {
  return NextResponse.json({ error: '审计服务暂不可用，请稍后重试' }, { status: 503 });
}

// 手动触发本地过期文件清理
export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:storage:cleanup',
    limit: 3,
    windowMs: 10 * 60_000,
  });
  if (response || !admin) return response!;

  const settings = await getSiteSettings({ fresh: true });

  if (settings.local_retention_days <= 0) {
    try {
      await writeSecurityAudit(req, {
        event: 'storage.cleanup',
        operator: { id: admin.id, email: admin.email, role: admin.role },
        target: { type: 'local_storage', id: 'global' },
        before: { retentionDays: settings.local_retention_days },
        reason: 'retention_disabled',
        outcome: 'DENIED',
      });
    } catch {
      return auditUnavailable();
    }
    return NextResponse.json({ error: '本地保留天数设置为永久保留，无需清理' }, { status: 400 });
  }

  if (settings.storage_mode !== 'cloudreve') {
    try {
      await writeSecurityAudit(req, {
        event: 'storage.cleanup',
        operator: { id: admin.id, email: admin.email, role: admin.role },
        target: { type: 'local_storage', id: 'global' },
        before: { storageMode: settings.storage_mode },
        reason: 'cloud_storage_required',
        outcome: 'DENIED',
      });
    } catch {
      return auditUnavailable();
    }
    return NextResponse.json({ error: '仅在 Cloudreve 模式下才能清理本地文件' }, { status: 400 });
  }

  try {
    const result = await trackJob(
      {
        type: JOB_TYPE.STORAGE_CLEANUP,
        triggeredBy: `admin:${admin.id}`,
        params: { retentionDays: settings.local_retention_days },
        resultSummary: (value) => ({
          deletedCount: value.deletedCount,
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
              event: 'storage.cleanup',
              operator: { id: admin.id, email: admin.email, role: admin.role },
              target: { type: 'local_storage', id: 'global' },
              before: { retentionDays: settings.local_retention_days },
              after: completed
                ? {
                    deletedCount: completed.deletedCount,
                    errorCount: completed.errorCount,
                  }
                : undefined,
              reason: 'admin_manual_cleanup',
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
      () => cleanupExpiredLocalFiles(settings.local_retention_days),
    );
    return NextResponse.json(result);
  } catch (err) {
    console.error('本地文件清理失败:', err);
    return NextResponse.json({ error: '清理失败' }, { status: 500 });
  }
}
