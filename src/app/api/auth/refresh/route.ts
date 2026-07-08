import { NextResponse } from 'next/server';
import {
  CLIENT_SESSION_TOKEN,
  extractToken,
  getJwtExpiryConfig,
  lookupRefreshGrace,
  peekTokenJti,
  recordRefreshGrace,
  revokeToken,
  setAuthCookie,
  signToken,
  verifyAuthSession,
  verifyAuthToken,
} from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getSiteSettings } from '@/lib/siteSettings';

/**
 * GET /api/auth/refresh
 * 从 HttpOnly cookie 中读取 JWT，验证后返回用户信息并续签 cookie。
 * 用于页面加载时自动恢复会话，无需重新登录。
 *
 * 幂等刷新（v3-R7）：单个 cookie 的并发刷新（多 Tab）或丢包时，第一个请求会 rotate
 * 出新 token 并把旧 jti 立即入黑名单。第二个请求带着「刚被 rotate 的旧 jti」到来时，
 * verifyAuthSession 会因黑名单命中而返回 null——此时不再直接 401，而是查一个短 TTL
 * 宽限记录，把同一个新 token 再发一次，让两个 Tab 收敛到同一个 cookie。宽限窗一过、
 * 或旧 jti 无宽限记录，则照常 401。宽限只在极短窗口内让「刚 rotate 的旧 jti」换回其
 * 对应的新 token，且返回前对新 token 走完整 verifyAuthToken，故重放/即时吊销保护不变。
 */
export async function GET(req: Request) {
  const session = await verifyAuthSession(req);

  if (!session) {
    // 会话校验失败：可能是并发/丢包下「刚被 rotate 的旧 jti」——尝试幂等宽限。
    return handleRefreshGrace(req);
  }

  const rateLimited = await enforceRateLimit(req, {
    scope: 'auth:refresh',
    limit: 60,
    windowMs: 60_000,
    key: `user:${session.user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  // 从数据库获取最新用户信息（角色可能已变更）
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      tokenVersion: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // 签发新 token（滑动过期 + 绝对过期：保留初始会话起点）
  const siteSettings = await getSiteSettings().catch(() => null);
  const jwtConfig = getJwtExpiryConfig(siteSettings?.jwt_expiry);
  const newToken = signToken(user, {
    sessionStartedAt: session.token.sessionStartedAt,
    expiresInDays: jwtConfig.expiresInDays,
  });
  // 先记宽限（旧 jti → 新 token），再吊销旧 jti：这样并发的第二个请求即使在吊销后到达，
  // 也能凭旧 jti 换回同一个新 token。宽限 TTL 极短，过后旧 jti 仍留在黑名单里彻底失效。
  await recordRefreshGrace(session.token.jti, newToken);
  await revokeToken(session.token);

  const response = buildRefreshResponse(user, newToken, jwtConfig.cookieMaxAge);
  return response;
}

/**
 * 旧 jti 已被 rotate（黑名单命中）时的幂等回退。
 * 仅当：token 签名/结构/绝对上限合法（peekTokenJti 通过，杜绝伪造）、且该 jti 有仍在
 * 宽限窗内的新 token、且该新 token 本身仍能通过完整 verifyAuthToken（签名/绝对上限/黑名单/
 * tokenVersion/status）时，才把新 token 再发一次。任何一步不满足 → 401。
 */
async function handleRefreshGrace(req: Request): Promise<NextResponse> {
  const rawToken = extractToken(req);
  if (!rawToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const jti = peekTokenJti(rawToken);
  if (!jti) {
    // 伪造/过期/篡改 token，或非本系统签发——直接拒绝。
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const graceToken = await lookupRefreshGrace(jti);
  if (!graceToken) {
    // 无宽限记录（宽限窗已过，或该 jti 从未被本流程 rotate）——旧 jti 照常彻底失效。
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 关键：对宽限 token 走完整校验。若两次刷新之间发生改密/封禁/tokenVersion 递增，
  // 该新 token 会在这里被拒（tokenVersion 不符或 status !== 1 或已被吊销），即时吊销不被绕过。
  const graceSession = await verifyAuthToken(graceToken);
  if (!graceSession) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceRateLimit(req, {
    scope: 'auth:refresh',
    limit: 60,
    windowMs: 60_000,
    key: `user:${graceSession.user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  const user = await prisma.user.findUnique({
    where: { id: graceSession.user.id },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      tokenVersion: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const siteSettings = await getSiteSettings().catch(() => null);
  const jwtConfig = getJwtExpiryConfig(siteSettings?.jwt_expiry);

  // 幂等：不再 rotate，也不吊销——把已 rotate 出的同一个新 token 原样再发，
  // 让并发/丢包的 Tab 收敛到与首个请求相同的 cookie（全局仍只有一个有效 token）。
  return buildRefreshResponse(user, graceToken, jwtConfig.cookieMaxAge);
}

function buildRefreshResponse(
  user: { id: string; email: string; displayName: string | null; role: string },
  token: string,
  cookieMaxAge: number
): NextResponse {
  const response = NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    },
    token: CLIENT_SESSION_TOKEN,
  });

  // 续签 cookie
  setAuthCookie(response, token, { maxAge: cookieMaxAge });

  // 防止浏览器缓存会话恢复响应
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');

  return response;
}
