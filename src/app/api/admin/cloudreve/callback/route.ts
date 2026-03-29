import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  exchangeAuthorizationCode,
  loadTokensIntoCache,
} from '@/lib/storage/cloudreve';
import { invalidateSiteSettingsCache } from '@/lib/siteSettings';

/**
 * GET /api/admin/cloudreve/callback?code=xxx
 * Cloudreve V4 OAuth 回调，用 authorization_code 换取 token 并持久化
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    // 授权被拒绝或出错，重定向到管理面板并附带错误信息
    return NextResponse.redirect(
      new URL(`/admin?cloudreve_error=${encodeURIComponent(error)}`, url.origin)
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL('/admin?cloudreve_error=missing_code', url.origin)
    );
  }

  try {
    // 从数据库读取之前存储的 code_verifier
    const verifierSetting = await prisma.siteSetting.findUnique({
      where: { key: 'cloudreve_code_verifier' },
    });

    if (!verifierSetting?.value) {
      return NextResponse.redirect(
        new URL('/admin?cloudreve_error=missing_verifier', url.origin)
      );
    }

    const codeVerifier = verifierSetting.value;
    const redirectUri = `${url.origin}/api/admin/cloudreve/callback`;

    // 用 code 换取 token
    const tokens = await exchangeAuthorizationCode(code, redirectUri, codeVerifier);

    // 持久化 token 到数据库
    await prisma.$transaction([
      prisma.siteSetting.upsert({
        where: { key: 'cloudreve_access_token' },
        update: { value: tokens.accessToken },
        create: { key: 'cloudreve_access_token', value: tokens.accessToken },
      }),
      prisma.siteSetting.upsert({
        where: { key: 'cloudreve_refresh_token' },
        update: { value: tokens.refreshToken },
        create: { key: 'cloudreve_refresh_token', value: tokens.refreshToken },
      }),
      prisma.siteSetting.upsert({
        where: { key: 'cloudreve_token_expires_at' },
        update: { value: String(tokens.expiresAt) },
        create: { key: 'cloudreve_token_expires_at', value: String(tokens.expiresAt) },
      }),
      // 清理 code_verifier
      prisma.siteSetting.delete({
        where: { key: 'cloudreve_code_verifier' },
      }),
    ]);

    // 加载到内存缓存
    loadTokensIntoCache(tokens);
    invalidateSiteSettingsCache();

    // 重定向回管理面板，带成功标记
    return NextResponse.redirect(
      new URL('/admin?cloudreve_authorized=true', url.origin)
    );
  } catch (err) {
    console.error('[Cloudreve OAuth] token 交换失败:', err);
    const errorMsg = err instanceof Error ? err.message : 'token_exchange_failed';
    return NextResponse.redirect(
      new URL(`/admin?cloudreve_error=${encodeURIComponent(errorMsg)}`, url.origin)
    );
  }
}
