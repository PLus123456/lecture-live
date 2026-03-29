import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import {
  isCloudreveConfiguredAsync,
  buildAuthorizeUrl,
  generateCodeVerifier,
} from '@/lib/storage/cloudreve';
import { prisma } from '@/lib/prisma';
import { resolvePublicAppOrigin } from '@/lib/requestOrigin';

/**
 * GET /api/admin/cloudreve/authorize
 * 发起 Cloudreve V4 OAuth 授权流程，返回授权 URL
 */
export async function GET(req: Request) {
  const { response } = await requireAdminAccess(req, {
    scope: 'admin:cloudreve:authorize',
    limit: 10,
    windowMs: 60_000,
  });
  if (response) return response;

  if (!(await isCloudreveConfiguredAsync())) {
    return NextResponse.json(
      { error: 'Cloudreve OAuth 未配置，请先在环境变量或管理面板中填写 Cloudreve 地址、Client ID、Client Secret' },
      { status: 400 }
    );
  }

  try {
    const origin = await resolvePublicAppOrigin(req);
    const redirectUri = `${origin}/api/admin/cloudreve/callback`;

    // 生成 PKCE code_verifier 并临时存入数据库
    const codeVerifier = generateCodeVerifier();

    await Promise.all([
      prisma.siteSetting.upsert({
        where: { key: 'cloudreve_code_verifier' },
        update: { value: codeVerifier },
        create: { key: 'cloudreve_code_verifier', value: codeVerifier },
      }),
      prisma.siteSetting.upsert({
        where: { key: 'cloudreve_redirect_uri' },
        update: { value: redirectUri },
        create: { key: 'cloudreve_redirect_uri', value: redirectUri },
      }),
    ]);

    const authorizeUrl = await buildAuthorizeUrl(redirectUri, codeVerifier);

    return NextResponse.json({ authorize_url: authorizeUrl });
  } catch (err) {
    console.error('[Cloudreve OAuth] 构建授权 URL 失败:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '构建授权 URL 失败' },
      { status: 500 }
    );
  }
}
