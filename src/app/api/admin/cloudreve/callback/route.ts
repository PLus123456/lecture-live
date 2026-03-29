import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  exchangeAuthorizationCode,
  loadTokensIntoCache,
} from '@/lib/storage/cloudreve';
import { invalidateSiteSettingsCache } from '@/lib/siteSettings';
import { resolvePublicAppOrigin } from '@/lib/requestOrigin';

function normalizeStoredRedirectUri(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}

/**
 * GET /api/admin/cloudreve/callback?code=xxx
 * Cloudreve V4 OAuth 回调，用 authorization_code 换取 token 并持久化
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const fallbackOrigin = await resolvePublicAppOrigin(req);

  const stateRows = await prisma.siteSetting.findMany({
    where: {
      key: {
        in: ['cloudreve_code_verifier', 'cloudreve_redirect_uri'],
      },
    },
  });
  const stateMap = new Map(stateRows.map((row) => [row.key, row.value]));
  const storedRedirectUri = normalizeStoredRedirectUri(
    stateMap.get('cloudreve_redirect_uri')
  );
  const redirectBaseOrigin = storedRedirectUri
    ? new URL(storedRedirectUri).origin
    : fallbackOrigin;

  if (error) {
    // 授权被拒绝或出错，重定向到管理面板并附带错误信息
    return NextResponse.redirect(
      new URL(`/admin?cloudreve_error=${encodeURIComponent(error)}`, redirectBaseOrigin)
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL('/admin?cloudreve_error=missing_code', redirectBaseOrigin)
    );
  }

  try {
    const codeVerifier = stateMap.get('cloudreve_code_verifier')?.trim();
    if (!codeVerifier) {
      return NextResponse.redirect(
        new URL('/admin?cloudreve_error=missing_verifier', redirectBaseOrigin)
      );
    }

    const redirectUri =
      storedRedirectUri ?? `${fallbackOrigin}/api/admin/cloudreve/callback`;

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
      // 清理临时 OAuth 状态，避免下次授权复用旧值
      prisma.siteSetting.deleteMany({
        where: {
          key: {
            in: ['cloudreve_code_verifier', 'cloudreve_redirect_uri'],
          },
        },
      }),
    ]);

    // 加载到内存缓存
    loadTokensIntoCache(tokens);
    invalidateSiteSettingsCache();

    // 重定向回管理面板，带成功标记
    return NextResponse.redirect(
      new URL('/admin?cloudreve_authorized=true', redirectBaseOrigin)
    );
  } catch (err) {
    console.error('[Cloudreve OAuth] token 交换失败:', err);
    const errorMsg = err instanceof Error ? err.message : 'token_exchange_failed';
    return NextResponse.redirect(
      new URL(`/admin?cloudreve_error=${encodeURIComponent(errorMsg)}`, redirectBaseOrigin)
    );
  }
}
