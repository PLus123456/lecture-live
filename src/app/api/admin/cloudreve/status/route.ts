import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import {
  getCloudreveAuthStatus,
  isCloudreveConfiguredAsync,
} from '@/lib/storage/cloudreve';
import { writeSecurityAudit } from '@/lib/securityAudit';

/**
 * GET /api/admin/cloudreve/status
 * 返回 Cloudreve OAuth 当前状态，供管理面板显示授权徽标。
 */
export async function GET(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:cloudreve:status',
    limit: 60,
    windowMs: 60_000,
  });
  if (response || !admin) return response!;

  try {
    const [configured, status] = await Promise.all([
      isCloudreveConfiguredAsync(),
      getCloudreveAuthStatus(),
    ]);

    // 配置/授权状态会暴露基础设施是否已接入及凭据是否存在，返回前必须留痕。
    await writeSecurityAudit(req, {
      event: 'cloudreve.status-read',
      operator: { id: admin.id, email: admin.email, role: admin.role },
      target: { type: 'cloudreve_oauth', id: 'global' },
      reason: 'admin_status_read',
      outcome: 'SUCCESS',
      metadata: {
        configured,
        authorized: status.authorized,
        hasExpiry: status.expiresAt !== null,
      },
    });

    return NextResponse.json({
      configured,
      authorized: status.authorized,
      expires_at: status.expiresAt,
    });
  } catch (err) {
    console.error('[admin.cloudreve.status] 失败:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '获取状态失败' },
      { status: 500 }
    );
  }
}
