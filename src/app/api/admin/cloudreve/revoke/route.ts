import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { clearPersistedTokens } from '@/lib/storage/cloudreve';
import { prisma } from '@/lib/prisma';
import { writeSecurityAudit } from '@/lib/securityAudit';

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
  if (response || !admin) return response!;

  try {
    await prisma.$transaction(async (tx) => {
      await clearPersistedTokens(tx);
      await writeSecurityAudit(
        req,
        {
          event: 'cloudreve.revoke',
          operator: { id: admin.id, email: admin.email, role: admin.role },
          target: { type: 'cloudreve_oauth', id: 'global' },
          before: { state: 'authorized_or_unknown' },
          after: { state: 'revoked' },
          reason: 'admin_oauth_revoke',
          outcome: 'SUCCESS',
        },
        tx
      );
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
