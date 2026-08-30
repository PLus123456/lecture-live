import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import {
  exchangeAuthorizationCode,
  loadTokensIntoCache,
} from '@/lib/storage/cloudreve';
import { invalidateSiteSettingsCache } from '@/lib/siteSettings';
import { resolvePublicAppOrigin } from '@/lib/requestOrigin';
import { encrypt } from '@/lib/crypto';
import { JOB_TYPE, trackJob } from '@/lib/jobQueue';
import { writeSecurityAudit } from '@/lib/securityAudit';

function auditUnavailableResponse() {
  return NextResponse.json(
    { error: '审计服务暂不可用，请稍后重试' },
    { status: 503 }
  );
}

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

type VerifierState = 'valid' | 'missing' | 'expired';

/**
 * 解析授权阶段写入的 PKCE code_verifier。
 *
 * authorize 端把 value 编码为 JSON `{ v, exp }`（exp 为过期时间戳 ms）：
 * - 未过期 → 返回 verifier；
 * - 已过期 / JSON 结构异常 → 视为无效（'expired'），拒绝换取 token；
 * - 缺失或为空 → 'missing'。
 *
 * 兼容旧版明文写法：若 value 不是合法 JSON，则当作裸 verifier 接受（无 TTL）——
 * 仅覆盖升级瞬间正在进行中的授权，新写入一律带 exp，因此不会留下永久残留。
 */
function parseStoredVerifier(
  value: string | null | undefined,
  now: number
): { state: VerifierState; verifier: string | null } {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { state: 'missing', verifier: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 旧版明文 verifier（非 JSON）——兼容接受，不强制 TTL。
    return { state: 'valid', verifier: trimmed };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { state: 'expired', verifier: null };
  }

  const record = parsed as { v?: unknown; exp?: unknown };
  const verifier = typeof record.v === 'string' ? record.v.trim() : '';
  const exp = typeof record.exp === 'number' ? record.exp : NaN;

  if (!verifier || !Number.isFinite(exp)) {
    return { state: 'expired', verifier: null };
  }

  if (exp <= now) {
    return { state: 'expired', verifier: null };
  }

  return { state: 'valid', verifier };
}

/**
 * GET /api/admin/cloudreve/callback?code=xxx
 * Cloudreve V4 OAuth 回调，用 authorization_code 换取 token 并持久化
 */
export async function GET(req: Request) {
  // 该回调仅靠 middleware 的 JWT 兜底，普通登录用户也能命中。
  // 这里补一道 requireAdminAccess：非管理员直接 403，避免被用来探测 / 触发 OAuth 交换。
  const { user: admin, response: accessResponse } = await requireAdminAccess(req, {
    scope: 'admin:cloudreve:callback',
    limit: 20,
    windowMs: 60_000,
  });
  if (accessResponse || !admin) return accessResponse!;

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
    try {
      await writeSecurityAudit(req, {
        event: 'cloudreve.callback',
        operator: { id: admin.id, email: admin.email, role: admin.role },
        target: { type: 'cloudreve_oauth', id: 'global' },
        before: { state: 'authorization_pending' },
        after: { state: 'authorization_denied' },
        reason: 'oauth_provider_denied',
        outcome: 'DENIED',
        metadata: { providerErrorPresent: true },
      });
    } catch {
      return auditUnavailableResponse();
    }
    // 不把 provider 可控的错误文本反射到管理页 URL；结构化审计只记录是否出现。
    return NextResponse.redirect(
      new URL('/admin?cloudreve_error=provider_denied', redirectBaseOrigin)
    );
  }

  if (!code) {
    try {
      await writeSecurityAudit(req, {
        event: 'cloudreve.callback',
        operator: { id: admin.id, email: admin.email, role: admin.role },
        target: { type: 'cloudreve_oauth', id: 'global' },
        before: { state: 'authorization_pending' },
        reason: 'oauth_code_missing',
        outcome: 'DENIED',
      });
    } catch {
      return auditUnavailableResponse();
    }
    return NextResponse.redirect(
      new URL('/admin?cloudreve_error=missing_code', redirectBaseOrigin)
    );
  }

  try {
    const { state: verifierState, verifier: codeVerifier } = parseStoredVerifier(
      stateMap.get('cloudreve_code_verifier'),
      Date.now()
    );
    if (verifierState === 'expired') {
      // 过期 / 损坏的 verifier 一律清掉，避免残留明文被复用。
      try {
        await prisma.$transaction(async (tx) => {
          await tx.siteSetting.deleteMany({
            where: {
              key: { in: ['cloudreve_code_verifier', 'cloudreve_redirect_uri'] },
            },
          });
          await writeSecurityAudit(
            req,
            {
              event: 'cloudreve.callback',
              operator: { id: admin.id, email: admin.email, role: admin.role },
              target: { type: 'cloudreve_oauth', id: 'global' },
              before: { state: 'authorization_pending' },
              after: { state: 'expired_state_removed' },
              reason: 'oauth_verifier_expired',
              outcome: 'DENIED',
            },
            tx
          );
        });
      } catch {
        return auditUnavailableResponse();
      }
      return NextResponse.redirect(
        new URL('/admin?cloudreve_error=expired_verifier', redirectBaseOrigin)
      );
    }
    if (!codeVerifier) {
      try {
        await writeSecurityAudit(req, {
          event: 'cloudreve.callback',
          operator: { id: admin.id, email: admin.email, role: admin.role },
          target: { type: 'cloudreve_oauth', id: 'global' },
          before: { state: 'authorization_pending' },
          reason: 'oauth_verifier_missing',
          outcome: 'DENIED',
        });
      } catch {
        return auditUnavailableResponse();
      }
      return NextResponse.redirect(
        new URL('/admin?cloudreve_error=missing_verifier', redirectBaseOrigin)
      );
    }

    const redirectUri =
      storedRedirectUri ?? `${fallbackOrigin}/api/admin/cloudreve/callback`;

    // JobQueue 先落 PROCESSING，再做不可回滚的 OAuth code exchange。返回值含 token，
    // 必须用 resultSummary 保证 durable journal 只保存非敏感摘要。
    const tokens = await trackJob(
      {
        type: JOB_TYPE.ADMIN_INTEGRATION,
        triggeredBy: `admin:${admin.id}`,
        params: { operation: 'cloudreve_oauth_callback' },
        resultSummary: (value) => ({
          authorized: true,
          expiresAt: value.expiresAt,
        }),
        errorSummary: (error) =>
          error instanceof Error ? error.name : 'UnknownError',
        terminalMutation: async (tx, terminal) => {
          if (terminal.status === 'FAILED') {
            await writeSecurityAudit(
              req,
              {
                event: 'cloudreve.callback',
                operator: { id: admin.id, email: admin.email, role: admin.role },
                target: { type: 'cloudreve_oauth', id: 'global' },
                before: { state: 'authorization_pending' },
                after: { state: 'authorization_failed' },
                reason: 'oauth_code_exchange',
                outcome: 'FAILED',
                metadata: {
                  errorClass:
                    terminal.error instanceof Error
                      ? terminal.error.name
                      : 'UnknownError',
                },
              },
              tx
            );
            return;
          }

          const encryptedAccess = encrypt(terminal.result.accessToken);
          const encryptedRefresh = encrypt(terminal.result.refreshToken);
          await Promise.all([
            tx.siteSetting.upsert({
              where: { key: 'cloudreve_access_token' },
              update: { value: encryptedAccess },
              create: { key: 'cloudreve_access_token', value: encryptedAccess },
            }),
            tx.siteSetting.upsert({
              where: { key: 'cloudreve_refresh_token' },
              update: { value: encryptedRefresh },
              create: { key: 'cloudreve_refresh_token', value: encryptedRefresh },
            }),
            tx.siteSetting.upsert({
              where: { key: 'cloudreve_token_expires_at' },
              update: { value: String(terminal.result.expiresAt) },
              create: {
                key: 'cloudreve_token_expires_at',
                value: String(terminal.result.expiresAt),
              },
            }),
            tx.siteSetting.deleteMany({
              where: {
                key: {
                  in: ['cloudreve_code_verifier', 'cloudreve_redirect_uri'],
                },
              },
            }),
          ]);
          await writeSecurityAudit(
            req,
            {
              event: 'cloudreve.callback',
              operator: { id: admin.id, email: admin.email, role: admin.role },
              target: { type: 'cloudreve_oauth', id: 'global' },
              before: { state: 'authorization_pending' },
              after: {
                state: 'authorized',
                expiresAt: terminal.result.expiresAt,
              },
              reason: 'oauth_code_exchange',
              outcome: 'SUCCESS',
            },
            tx
          );
        },
      },
      () =>
        exchangeAuthorizationCode(
          code,
          redirectUri,
          codeVerifier
        )
    );

    // 加载到内存缓存
    loadTokensIntoCache(tokens);
    invalidateSiteSettingsCache();

    // 重定向回管理面板，带成功标记
    return NextResponse.redirect(
      new URL('/admin?cloudreve_authorized=true', redirectBaseOrigin)
    );
  } catch (err) {
    console.error('[Cloudreve OAuth] token 交换失败:', err);
    return NextResponse.redirect(
      new URL('/admin?cloudreve_error=token_exchange_failed', redirectBaseOrigin)
    );
  }
}
