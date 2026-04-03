import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { getSiteSettings } from '@/lib/siteSettings';
import { cleanupExpiredLocalFiles } from '@/lib/storage/migration';
import { trackJob, JOB_TYPE } from '@/lib/jobQueue';

// 手动触发本地过期文件清理
export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:storage:cleanup',
    limit: 3,
    windowMs: 10 * 60_000,
  });
  if (response) return response;

  const settings = await getSiteSettings({ fresh: true });

  if (settings.local_retention_days <= 0) {
    return NextResponse.json({ error: '本地保留天数设置为永久保留，无需清理' }, { status: 400 });
  }

  if (settings.storage_mode !== 'cloudreve') {
    return NextResponse.json({ error: '仅在 Cloudreve 模式下才能清理本地文件' }, { status: 400 });
  }

  logAction(req, 'admin.storage.cleanup', {
    user: admin,
    detail: `手动触发本地文件清理，保留天数: ${settings.local_retention_days}`,
  });

  try {
    const result = await trackJob(
      {
        type: JOB_TYPE.STORAGE_CLEANUP,
        triggeredBy: `admin:${admin!.id}`,
        params: { retentionDays: settings.local_retention_days },
      },
      () => cleanupExpiredLocalFiles(settings.local_retention_days),
    );
    return NextResponse.json(result);
  } catch (err) {
    console.error('本地文件清理失败:', err);
    return NextResponse.json({ error: '清理失败' }, { status: 500 });
  }
}
