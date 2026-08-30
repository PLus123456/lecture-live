import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import {
  isCloudreveConfiguredAsync,
  buildAuthorizeUrl,
  generateCodeVerifier,
} from '@/lib/storage/cloudreve';
import { prisma } from '@/lib/prisma';
import { resolvePublicAppOrigin } from '@/lib/requestOrigin';
import { writeSecurityAudit } from '@/lib/securityAudit';

/**
 * PKCE code_verifier 在 SiteSetting 中的存活时间（10 分钟）。
 * 授权流程从跳转到回调通常只需数秒，10 分钟足够覆盖人工同意页停留，
 * 又能确保用户中断授权后残留的明文 verifier 很快失效、无法被复用。
 */
const PKCE_VERIFIER_TTL_MS = 10 * 60 * 1000;

/**
 * 把 PKCE code_verifier 连同过期时间戳编码进 SiteSetting 的 value。
 * 不新增表/列，用 JSON 在单个 value 内携带 TTL；callback 取用时校验未过期。
 */
function encodeCodeVerifier(verifier: string, now: number): string {
  return JSON.stringify({ v: verifier, exp: now + PKCE_VERIFIER_TTL_MS });
}

/**
 * GET /api/admin/cloudreve/authorize
 * 发起 Cloudreve V4 OAuth 授权流程，返回授权 URL
 */
export async function GET(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:cloudreve:authorize',
    limit: 10,
    windowMs: 60_000,
  });
  if (response || !admin) return response!;

  if (!(await isCloudreveConfiguredAsync())) {
    try {
      await writeSecurityAudit(req, {
        event: 'cloudreve.authorize',
        operator: { id: admin.id, email: admin.email, role: admin.role },
        target: { type: 'cloudreve_oauth', id: 'global' },
        before: { configured: false },
        reason: 'oauth_not_configured',
        outcome: 'DENIED',
      });
    } catch {
      return NextResponse.json(
        { error: '审计服务暂不可用，请稍后重试' },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: 'Cloudreve OAuth 未配置，请先在环境变量或管理面板中填写 Cloudreve 地址、Client ID、Client Secret' },
      { status: 400 }
    );
  }

  try {
    const origin = await resolvePublicAppOrigin(req);
    const redirectUri = `${origin}/api/admin/cloudreve/callback`;

    // 生成 PKCE code_verifier 并临时存入数据库（带过期时间戳）
    const codeVerifier = generateCodeVerifier();
    const storedVerifier = encodeCodeVerifier(codeVerifier, Date.now());

    const authorizeUrl = await buildAuthorizeUrl(redirectUri, codeVerifier);

    // PKCE 全局状态与成功审计同事务提交；审计不可用时不留下可消费的 verifier。
    await prisma.$transaction(async (tx) => {
      await Promise.all([
        tx.siteSetting.upsert({
          where: { key: 'cloudreve_code_verifier' },
          update: { value: storedVerifier },
          create: { key: 'cloudreve_code_verifier', value: storedVerifier },
        }),
        tx.siteSetting.upsert({
          where: { key: 'cloudreve_redirect_uri' },
          update: { value: redirectUri },
          create: { key: 'cloudreve_redirect_uri', value: redirectUri },
        }),
      ]);
      await writeSecurityAudit(
        req,
        {
          event: 'cloudreve.authorize',
          operator: { id: admin.id, email: admin.email, role: admin.role },
          target: { type: 'cloudreve_oauth', id: 'global' },
          before: { state: 'idle' },
          after: {
            state: 'authorization_pending',
            redirectOrigin: new URL(redirectUri).origin,
          },
          reason: 'admin_oauth_authorization_start',
          outcome: 'SUCCESS',
        },
        tx
      );
    });

    return NextResponse.json({ authorize_url: authorizeUrl });
  } catch (err) {
    console.error('[Cloudreve OAuth] 构建授权 URL 失败:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '构建授权 URL 失败' },
      { status: 500 }
    );
  }
}
