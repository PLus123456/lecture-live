import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { clearPersistedTokens } from '@/lib/storage/cloudreve';

/**
 * POST /api/admin/cloudreve/revoke
 * 管理员主动撤销 Cloudreve 授权：
 * 清除内存缓存与数据库中持久化的 access/refresh token。
 * 用于 refresh_token 死锁、配置异常等场景的"自助恢复"入口。
 */
export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:cloudreve:revoke',
    limit: 10,
    windowMs: 60_000,
  });
  if (response) return response;

  try {
    await clearPersistedTokens();

    logAction(req, 'admin.cloudreve.revoke', {
      user: admin,
      detail: '管理员撤销 Cloudreve OAuth 授权（清除已持久化的 token）',
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[admin.cloudreve.revoke] 失败:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '撤销授权失败' },
      { status: 500 }
    );
  }
}
