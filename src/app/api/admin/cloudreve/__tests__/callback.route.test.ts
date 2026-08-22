import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdminAccessMock,
  exchangeAuthorizationCodeMock,
  loadTokensIntoCacheMock,
  invalidateSiteSettingsCacheMock,
  siteSettingFindManyMock,
  siteSettingUpsertMock,
  siteSettingDeleteManyMock,
  transactionMock,
  trackJobMock,
  securityAuditMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  exchangeAuthorizationCodeMock: vi.fn(),
  loadTokensIntoCacheMock: vi.fn(),
  invalidateSiteSettingsCacheMock: vi.fn(),
  siteSettingFindManyMock: vi.fn(),
  siteSettingUpsertMock: vi.fn(),
  siteSettingDeleteManyMock: vi.fn(),
  transactionMock: vi.fn(),
  trackJobMock: vi.fn(),
  securityAuditMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/storage/cloudreve', () => ({
  exchangeAuthorizationCode: exchangeAuthorizationCodeMock,
  loadTokensIntoCache: loadTokensIntoCacheMock,
}));

vi.mock('@/lib/siteSettings', () => ({
  invalidateSiteSettingsCache: invalidateSiteSettingsCacheMock,
  getSiteSettings: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: {
      findMany: siteSettingFindManyMock,
      upsert: siteSettingUpsertMock,
      deleteMany: siteSettingDeleteManyMock,
    },
    $transaction: transactionMock,
  },
}));
vi.mock('@/lib/jobQueue', () => ({
  JOB_TYPE: { ADMIN_INTEGRATION: 'admin_integration' },
  trackJob: trackJobMock,
}));
vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: securityAuditMock,
}));

import { NextResponse } from 'next/server';

import { GET } from '@/app/api/admin/cloudreve/callback/route';

/** authorize 端写入 SiteSetting 的 JSON 编码（含未过期的 exp） */
function encodeVerifier(verifier: string, ttlMs = 10 * 60 * 1000): string {
  return JSON.stringify({ v: verifier, exp: Date.now() + ttlMs });
}

describe('GET /api/admin/cloudreve/callback', () => {
  beforeEach(() => {
    requireAdminAccessMock.mockReset();
    exchangeAuthorizationCodeMock.mockReset();
    loadTokensIntoCacheMock.mockReset();
    invalidateSiteSettingsCacheMock.mockReset();
    siteSettingFindManyMock.mockReset();
    siteSettingUpsertMock.mockReset();
    siteSettingDeleteManyMock.mockReset();
    transactionMock.mockReset();
    trackJobMock.mockReset();
    securityAuditMock.mockReset().mockResolvedValue(undefined);

    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' },
      response: null,
    });
    siteSettingFindManyMock.mockResolvedValue([
      { key: 'cloudreve_code_verifier', value: encodeVerifier('verifier-123') },
      {
        key: 'cloudreve_redirect_uri',
        value: 'https://lecture.example.com/api/admin/cloudreve/callback',
      },
    ]);
    exchangeAuthorizationCodeMock.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_800_000_000_000,
    });
    siteSettingUpsertMock.mockImplementation((payload: unknown) => payload);
    // deleteMany 在生产中返回 Promise；过期分支会直接 `.catch()` 它，
    // 因此 mock 必须返回 thenable（resolve），否则会误触发 catch 链异常。
    siteSettingDeleteManyMock.mockResolvedValue({ count: 0 });
    const tx = {
      siteSetting: {
        upsert: siteSettingUpsertMock,
        deleteMany: siteSettingDeleteManyMock,
      },
    };
    transactionMock.mockImplementation(
      async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)
    );
    trackJobMock.mockImplementation(
      async (
        options: {
          terminalMutation?: (
            value: typeof tx,
            terminal:
              | { status: 'SUCCESS'; result: unknown }
              | { status: 'FAILED'; error: unknown }
          ) => Promise<void>;
        },
        fn: () => Promise<unknown>
      ) => {
        let result: unknown;
        try {
          result = await fn();
        } catch (error) {
          await options.terminalMutation?.(tx, { status: 'FAILED', error });
          throw error;
        }
        await options.terminalMutation?.(tx, { status: 'SUCCESS', result });
        return result;
      }
    );
  });

  it('使用授权阶段保存的 redirect_uri 交换 token，并回到外部域名', async () => {
    const response = await GET(
      new Request('http://127.0.0.1:3000/api/admin/cloudreve/callback?code=auth-code', {
        headers: {
          host: 'lecture.example.com',
          'x-forwarded-proto': 'https',
        },
      })
    );

    expect(exchangeAuthorizationCodeMock).toHaveBeenCalledWith(
      'auth-code',
      'https://lecture.example.com/api/admin/cloudreve/callback',
      'verifier-123'
    );
    expect(siteSettingDeleteManyMock).toHaveBeenCalledWith({
      where: {
        key: {
          in: ['cloudreve_code_verifier', 'cloudreve_redirect_uri'],
        },
      },
    });
    expect(loadTokensIntoCacheMock).toHaveBeenCalledWith({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_800_000_000_000,
    });
    expect(invalidateSiteSettingsCacheMock).toHaveBeenCalledTimes(1);
    expect(response.headers.get('location')).toBe(
      'https://lecture.example.com/admin?cloudreve_authorized=true'
    );
    expect(trackJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'admin_integration',
        params: { operation: 'cloudreve_oauth_callback' },
        resultSummary: expect.any(Function),
      }),
      expect.any(Function)
    );
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ event: 'cloudreve.callback', outcome: 'SUCCESS' }),
      expect.any(Object)
    );
  });

  it('非管理员命中回调时返回 requireAdminAccess 的 403，不触碰 OAuth 状态', async () => {
    requireAdminAccessMock.mockResolvedValue({
      user: null,
      response: NextResponse.json({ error: '权限不足' }, { status: 403 }),
    });

    const response = await GET(
      new Request('http://127.0.0.1:3000/api/admin/cloudreve/callback?code=auth-code')
    );

    expect(response.status).toBe(403);
    // 鉴权失败应在读取/交换之前短路
    expect(siteSettingFindManyMock).not.toHaveBeenCalled();
    expect(exchangeAuthorizationCodeMock).not.toHaveBeenCalled();
  });

  it('不反射 provider 可控错误文本，也不把它写入审计', async () => {
    const attackerText = '<script>alert(1)</script>&access_token=leaked';
    const response = await GET(
      new Request(
        `https://lecture.example.com/api/admin/cloudreve/callback?error=${encodeURIComponent(attackerText)}`
      )
    );

    expect(response.headers.get('location')).toBe(
      'https://lecture.example.com/admin?cloudreve_error=provider_denied'
    );
    expect(exchangeAuthorizationCodeMock).not.toHaveBeenCalled();
    expect(JSON.stringify(securityAuditMock.mock.calls)).not.toContain(attackerText);
    expect(JSON.stringify(securityAuditMock.mock.calls)).not.toContain('access_token');
  });

  it('code_verifier 已过期时拒绝换取 token 并清理残留状态', async () => {
    siteSettingFindManyMock.mockResolvedValue([
      {
        key: 'cloudreve_code_verifier',
        // exp 落在过去 → 视为过期
        value: JSON.stringify({ v: 'verifier-123', exp: Date.now() - 1 }),
      },
      {
        key: 'cloudreve_redirect_uri',
        value: 'https://lecture.example.com/api/admin/cloudreve/callback',
      },
    ]);

    const response = await GET(
      new Request('http://127.0.0.1:3000/api/admin/cloudreve/callback?code=auth-code', {
        headers: { host: 'lecture.example.com', 'x-forwarded-proto': 'https' },
      })
    );

    expect(exchangeAuthorizationCodeMock).not.toHaveBeenCalled();
    // 过期 verifier 应被主动删除，避免明文长期残留
    expect(siteSettingDeleteManyMock).toHaveBeenCalledWith({
      where: {
        key: { in: ['cloudreve_code_verifier', 'cloudreve_redirect_uri'] },
      },
    });
    expect(response.headers.get('location')).toBe(
      'https://lecture.example.com/admin?cloudreve_error=expired_verifier'
    );
    expect(securityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ outcome: 'DENIED', reason: 'oauth_verifier_expired' }),
      expect.any(Object)
    );
  });

  it('结构损坏的 code_verifier 视为过期，不换取 token', async () => {
    siteSettingFindManyMock.mockResolvedValue([
      // 合法 JSON 但缺 exp → 损坏，按过期处理
      { key: 'cloudreve_code_verifier', value: JSON.stringify({ v: 'verifier-123' }) },
      {
        key: 'cloudreve_redirect_uri',
        value: 'https://lecture.example.com/api/admin/cloudreve/callback',
      },
    ]);

    const response = await GET(
      new Request('http://127.0.0.1:3000/api/admin/cloudreve/callback?code=auth-code', {
        headers: { host: 'lecture.example.com', 'x-forwarded-proto': 'https' },
      })
    );

    expect(exchangeAuthorizationCodeMock).not.toHaveBeenCalled();
    expect(response.headers.get('location')).toBe(
      'https://lecture.example.com/admin?cloudreve_error=expired_verifier'
    );
  });

  it('兼容旧版明文 verifier（非 JSON）以免升级瞬间中断进行中的授权', async () => {
    siteSettingFindManyMock.mockResolvedValue([
      { key: 'cloudreve_code_verifier', value: 'legacy-plain-verifier' },
      {
        key: 'cloudreve_redirect_uri',
        value: 'https://lecture.example.com/api/admin/cloudreve/callback',
      },
    ]);

    const response = await GET(
      new Request('http://127.0.0.1:3000/api/admin/cloudreve/callback?code=auth-code', {
        headers: { host: 'lecture.example.com', 'x-forwarded-proto': 'https' },
      })
    );

    expect(exchangeAuthorizationCodeMock).toHaveBeenCalledWith(
      'auth-code',
      'https://lecture.example.com/api/admin/cloudreve/callback',
      'legacy-plain-verifier'
    );
    expect(response.headers.get('location')).toBe(
      'https://lecture.example.com/admin?cloudreve_authorized=true'
    );
  });

  it('token 状态成功审计失败时关闭失败且不加载内存凭据', async () => {
    securityAuditMock.mockRejectedValue(new Error('audit unavailable'));
    const response = await GET(
      new Request('http://127.0.0.1:3000/api/admin/cloudreve/callback?code=auth-code', {
        headers: { host: 'lecture.example.com', 'x-forwarded-proto': 'https' },
      })
    );
    expect(response.headers.get('location')).toBe(
      'https://lecture.example.com/admin?cloudreve_error=token_exchange_failed'
    );
    expect(loadTokensIntoCacheMock).not.toHaveBeenCalled();
  });
});
