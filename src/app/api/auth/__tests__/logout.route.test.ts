import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  extractToken: vi.fn(),
  extractCookieToken: vi.fn(),
  getAuthTokenSessionBinding: vi.fn(),
  revokeByBinding: vi.fn(),
  logAction: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  AUTH_SESSION_BINDING_HEADER: 'X-Lecture-Live-Auth-Session',
  extractToken: mocks.extractToken,
  extractTokenFromCookieHeader: mocks.extractCookieToken,
  getAuthTokenSessionBinding: mocks.getAuthTokenSessionBinding,
  revokeAuthSessionByBinding: mocks.revokeByBinding,
}));
vi.mock('@/lib/auditLog', () => ({ logAction: mocks.logAction }));

import { POST } from '@/app/api/auth/logout/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.extractToken.mockReturnValue('raw-token-a');
  mocks.extractCookieToken.mockReturnValue('raw-token-a');
  mocks.getAuthTokenSessionBinding.mockReturnValue('capability-a');
  mocks.revokeByBinding.mockResolvedValue({
    status: 'revoked',
    familyId: 'family-a',
    userId: 'user-a',
  });
});

function boundRequest(
  binding = 'capability-a',
  cookie = 'raw-token-a',
  extraHeaders?: Record<string, string>
) {
  return new Request('http://localhost/api/auth/logout', {
    method: 'POST',
    headers: {
      Cookie: `lecture-live-token=${cookie}`,
      'X-Lecture-Live-Auth-Session': binding,
      ...extraHeaders,
    },
  });
}

describe('POST /api/auth/logout', () => {
  it('按 revoke-only capability 持久撤销当前 family；响应不写 cookie', async () => {
    const response = await POST(boundRequest());

    expect(response.status).toBe(200);
    expect(mocks.revokeByBinding).toHaveBeenCalledWith('capability-a', {
      reason: 'logout',
    });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('clear-site-data')).toBe('"cache"');
    expect(mocks.logAction).toHaveBeenCalledWith(
      expect.any(Request),
      'user.logout',
      expect.objectContaining({
        userId: 'user-a',
        detail: 'Auth family revoked by revoke-only capability',
      })
    );
  });

  it('DB 撤销/复查故障失败关闭为 503，且不碰当前 cookie/cache', async () => {
    mocks.revokeByBinding.mockRejectedValueOnce(
      new Error('database unavailable')
    );

    const response = await POST(boundRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('clear-site-data')).toBeNull();
    expect(mocks.logAction).not.toHaveBeenCalledWith(
      expect.any(Request),
      'user.logout',
      expect.anything()
    );
    expect(mocks.logAction).toHaveBeenCalledWith(
      expect.any(Request),
      'user.logout.failed',
      expect.objectContaining({
        detail: 'Persistent auth-family revocation unavailable',
      })
    );
  });

  it('篡改、错 purpose、过期或旧 hash binding 由 capability 边界拒绝', async () => {
    mocks.revokeByBinding.mockResolvedValue({ status: 'invalid' });

    const response = await POST(boundRequest('a'.repeat(64)));

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('clear-site-data')).toBeNull();
    expect(mocks.logAction).not.toHaveBeenCalledWith(
      expect.any(Request),
      'user.logout',
      expect.anything()
    );
  });

  it('当前 cookie 已是 B 时，迟到 binding-A 仍只撤 A，绝不写/清 B', async () => {
    mocks.extractToken.mockReturnValue('raw-token-b');
    mocks.extractCookieToken.mockReturnValue('raw-token-b');
    mocks.getAuthTokenSessionBinding.mockReturnValue('capability-b');

    const response = await POST(boundRequest('capability-a', 'raw-token-b'));

    expect(response.status).toBe(200);
    expect(mocks.revokeByBinding).toHaveBeenCalledWith('capability-a', {
      reason: 'logout',
    });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('clear-site-data')).toBeNull();
  });

  it('当前 cookie 无法解析时也不会改换目标；有效 capability 仍只撤其 family', async () => {
    mocks.getAuthTokenSessionBinding.mockReturnValue(null);

    const response = await POST(boundRequest());

    expect(response.status).toBe(200);
    expect(mocks.revokeByBinding).toHaveBeenCalledWith('capability-a', {
      reason: 'logout',
    });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('clear-site-data')).toBeNull();
  });

  it('有认证凭据但缺 capability 时失败关闭，完全匿名重试保持无副作用 2xx', async () => {
    const missing = await POST(
      new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { Cookie: 'lecture-live-token=raw-token-a' },
      })
    );
    mocks.extractToken.mockReturnValue(null);
    mocks.extractCookieToken.mockReturnValue(null);
    const anonymous = await POST(
      new Request('http://localhost/api/auth/logout', { method: 'POST' })
    );

    expect(missing.status).toBe(428);
    expect(anonymous.status).toBe(200);
    expect(mocks.revokeByBinding).not.toHaveBeenCalled();
    expect(missing.headers.get('set-cookie')).toBeNull();
    expect(anonymous.headers.get('set-cookie')).toBeNull();
  });

  it('首次 200 丢包后的 revoked/missing family 重试幂等 2xx', async () => {
    mocks.revokeByBinding.mockResolvedValueOnce({
      status: 'already_invalid',
      familyId: 'family-a',
      userId: 'user-a',
    });

    const response = await POST(boundRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(mocks.logAction).toHaveBeenCalledWith(
      expect.any(Request),
      'user.logout',
      expect.objectContaining({
        userId: 'user-a',
        detail: 'Auth family already revoked or permanently invalid',
      })
    );
  });

  it('两个并发撤销的 winner/count0 follower 均映射为幂等 2xx', async () => {
    mocks.revokeByBinding
      .mockResolvedValueOnce({
        status: 'revoked',
        familyId: 'family-a',
        userId: 'user-a',
      })
      .mockResolvedValueOnce({
        status: 'already_invalid',
        familyId: 'family-a',
        userId: 'user-a',
      });

    const responses = await Promise.all([
      POST(boundRequest()),
      POST(boundRequest()),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.every((response) => !response.headers.has('set-cookie'))).toBe(
      true
    );
  });

  it('跨站 auth mutation 在 capability/DB 前拒绝且不写 cookie/cache', async () => {
    const response = await POST(
      boundRequest('capability-a', 'raw-token-a', {
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.revokeByBinding).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('clear-site-data')).toBeNull();
  });
});
