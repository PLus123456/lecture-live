import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { migrateLocalToCloudreve } from '@/lib/storage/migration';

// 手动触发本地 → Cloudreve 迁移
export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:storage:migrate',
    limit: 3,
    windowMs: 10 * 60_000,
  });
  if (response) return response;

  logAction(req, 'admin.storage.migrate', {
    user: admin,
    detail: '手动触发存储迁移：本地 → Cloudreve',
  });

  try {
    const result = await migrateLocalToCloudreve();
    return NextResponse.json(result);
  } catch (err) {
    console.error('存储迁移失败:', err);
    return NextResponse.json({ error: '迁移失败' }, { status: 500 });
  }
}
