import { NextResponse } from 'next/server';
import {
  AUTH_SESSION_BINDING_HEADER,
  extractToken,
  extractTokenFromCookieHeader,
  getAuthTokenSessionBinding,
  revokeAuthSessionByBinding,
} from '@/lib/auth';
import { logAction } from '@/lib/auditLog';
import { guardAuthMutationRequest } from '@/lib/publicAuth';

/**
 * POST /api/auth/logout
 * 清除 HttpOnly auth cookie，完成服务端登出。
 * 添加 Cache-Control 确保浏览器不缓存此响应。
 */
export async function POST(req: Request) {
  const requestGuard = guardAuthMutationRequest(req);
  if (requestGuard) return requestGuard;
  const rawToken = extractToken(req);
  const cookieToken = extractTokenFromCookieHeader(req.headers.get('Cookie'));
  const revocationBinding = req.headers.get(AUTH_SESSION_BINDING_HEADER);

  if (!revocationBinding) {
    // 有凭据的 logout 必须明确携带 revoke-only capability，不能退回“当前 Cookie 就是目标”
    // 的竞态语义。完全匿名的重复 logout 仍保持无副作用的 2xx。
    return buildLogoutResponse(
      rawToken ? { error: 'Session binding required' } : { message: 'Logged out' },
      rawToken ? 428 : 200
    );
  }

  // 当前 Cookie 仅用于判断成功后能否安全清它所属主体的 HTTP cache；撤销目标完全来自
  // capability。故迟到的 binding-A 即使此刻 Cookie 已是 B，也只能撤 A，绝不会碰 B。
  const currentCookieBinding = cookieToken
    ? getAuthTokenSessionBinding(cookieToken)
    : null;
  const targetsCurrentCookie =
    currentCookieBinding !== null && currentCookieBinding === revocationBinding;

  let resolution;
  try {
    resolution = await revokeAuthSessionByBinding(revocationBinding, {
      reason: 'logout',
    });
  } catch (error) {
    console.error('Persistent logout revocation failed:', error);
    logAction(req, 'user.logout.failed', {
      detail: 'Persistent auth-family revocation unavailable',
    });
    return buildLogoutResponse(
      { error: 'Logout revocation unavailable' },
      503
    );
  }

  if (resolution.status === 'invalid') {
    // 旧版裸 SHA-256、篡改/错 purpose/错 target，及试图命中活跃行的过期 capability
    // 全部失败关闭；签名目标已被 DB 确认永久无效时才允许幂等 2xx。
    return buildLogoutResponse({ error: 'Unauthorized' }, 401);
  }

  // 只有持久 family 已撤销或 DB 已确认永久无效后，才能留下成功审计。
  logAction(req, 'user.logout', {
    userId: resolution.userId,
    detail:
      resolution.status === 'already_invalid'
        ? 'Auth family already revoked or permanently invalid'
        : 'Auth family revoked by revoke-only capability',
  });
  return buildLogoutResponse({ message: 'Logged out' }, 200, {
    clearCache: !cookieToken || targetsCurrentCookie,
  });
}

function buildLogoutResponse(
  body: { message: string } | { error: string },
  status: number,
  options?: { clearCache?: boolean }
): NextResponse {
  const response = NextResponse.json(body, { status });
  // 所有路径故意不返回 Set-Cookie。响应到达时 Cookie 可能已属于新主体 B；持久 family
  // 撤销才是安全真源，迟到的 A 响应不能删除或覆盖 B。
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  response.headers.set('Pragma', 'no-cache');
  if (options?.clearCache) {
    // 只在 capability 确实对应当前 Cookie（或浏览器已经没有 Cookie）时清 HTTP cache。
    response.headers.set('Clear-Site-Data', '"cache"');
  }
  return response;
}
