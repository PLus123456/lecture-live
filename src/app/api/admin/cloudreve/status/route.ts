import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import {
  getCloudreveAuthStatus,
  isCloudreveConfiguredAsync,
} from '@/lib/storage/cloudreve';

/**
 * GET /api/admin/cloudreve/status
 * 返回 Cloudreve OAuth 当前状态，供管理面板显示授权徽标。
 */
export async function GET(req: Request) {
  const { response } = await requireAdminAccess(req, {
    scope: 'admin:cloudreve:status',
    limit: 60,
    windowMs: 60_000,
  });
  if (response) return response;

  try {
    const [configured, status] = await Promise.all([
      isCloudreveConfiguredAsync(),
      getCloudreveAuthStatus(),
    ]);

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
