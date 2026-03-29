import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import {
  isCloudreveConfigured,
  buildAuthorizeUrl,
  generateCodeVerifier,
} from '@/lib/storage/cloudreve';
import { prisma } from '@/lib/prisma';

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

  if (!isCloudreveConfigured()) {
    return NextResponse.json(
      { error: 'Cloudreve OAuth 未配置，请先设置 CLOUDREVE_BASE_URL、CLOUDREVE_CLIENT_ID、CLOUDREVE_CLIENT_SECRET' },
      { status: 400 }
    );
  }

  try {
    const url = new URL(req.url);
    const origin = url.origin;
    const redirectUri = `${origin}/api/admin/cloudreve/callback`;

    // 生成 PKCE code_verifier 并临时存入数据库
    const codeVerifier = generateCodeVerifier();

    await prisma.siteSetting.upsert({
      where: { key: 'cloudreve_code_verifier' },
      update: { value: codeVerifier },
      create: { key: 'cloudreve_code_verifier', value: codeVerifier },
    });

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
