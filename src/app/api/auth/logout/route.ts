import { NextResponse } from 'next/server';
import { clearAuthCookie, revokeToken, verifyAuthSession } from '@/lib/auth';
import { logAction } from '@/lib/auditLog';

/**
 * POST /api/auth/logout
 * 清除 HttpOnly auth cookie，完成服务端登出。
 * 添加 Cache-Control 确保浏览器不缓存此响应。
 */
export async function POST(req: Request) {
  const session = await verifyAuthSession(req);
  const response = NextResponse.json({ message: 'Logged out' });
  if (session) {
    logAction(req, 'user.logout', { user: session.user });
    await revokeToken(session.token);
  }
  clearAuthCookie(response);
  // 防止浏览器缓存登出响应
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  response.headers.set('Pragma', 'no-cache');
  return response;
}
