import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../tests/utils/http';
import { hashToken } from '@/lib/email/tokens';

/**
 * 与 reset-password.route.test 同套路：不 mock @/lib/email/tokens（要跑真实认领语义），
 * prisma 用记录「哪些写入最终提交」的替身，以此守住 #7 的不变量——
 * 认领必须与它授权的那步写入同进同退，绝不能先烧后用。
 */

const RAW_TOKEN = 'raw-verify-token';

type TokenRow = {
  id: string;
  tokenHash: string;
  userId: string;
  type: 'VERIFY_EMAIL' | 'RESET_PASSWORD';
  consumedAt: Date | null;
  expiresAt: Date;
};

type UserRow = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: number;
  tokenVersion: number;
  emailVerifiedAt: Date | null;
};

const {
  fake,
  state,
  getSiteSettingsMock,
  enforceRateLimitMock,
  logActionMock,
  resolveRequestClientIpMock,
  sendWelcomeEmailMock,
} = await vi.hoisted(async () => {
  const { createFakeTxPrisma } = await import('../../../../../tests/utils/fakeTxPrisma');
  const { vi: v } = await import('vitest');

  const state: {
    tokens: TokenRow[];
    userRow: UserRow | null;
    userUpdateImpl: (args: unknown) => unknown;
  } = { tokens: [], userRow: null, userUpdateImpl: () => ({}) };

  const fake = createFakeTxPrisma({
    emailToken: {
      findUnique: ((args: { where: { tokenHash: string } }) =>
        state.tokens.find((t) => t.tokenHash === args.where.tokenHash) ?? null) as never,
      updateMany: ((args: {
        where: { id?: string; userId?: string; expiresAt?: { gt: Date } };
        data: { consumedAt: Date };
      }) => {
        const { where, data } = args;
        const matched = state.tokens.filter(
          (t) =>
            (where.id === undefined || t.id === where.id) &&
            (where.userId === undefined || t.userId === where.userId) &&
            t.consumedAt === null &&
            (where.expiresAt === undefined || t.expiresAt > where.expiresAt.gt)
        );
        matched.forEach((t) => {
          t.consumedAt = data.consumedAt;
        });
        return { count: matched.length };
      }) as never,
    },
    user: {
      findUnique: (() => state.userRow) as never,
      update: ((args: unknown) => state.userUpdateImpl(args)) as never,
    },
  });

  return {
    fake,
    state,
    getSiteSettingsMock: v.fn(),
    enforceRateLimitMock: v.fn(),
    logActionMock: v.fn(),
    resolveRequestClientIpMock: v.fn(),
    sendWelcomeEmailMock: v.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: fake.client }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/auditLog', () => ({ logAction: logActionMock }));
vi.mock('@/lib/clientIp', () => ({ resolveRequestClientIp: resolveRequestClientIpMock }));
vi.mock('@/lib/email', () => ({ sendWelcomeEmail: sendWelcomeEmailMock }));

import { POST } from '@/app/api/auth/verify-email/route';

const dayFromNow = () => new Date(Date.now() + 24 * 60 * 60_000);

describe('POST /api/auth/verify-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.reset();

    state.tokens = [
      {
        id: 'tok-verify',
        tokenHash: hashToken(RAW_TOKEN),
        userId: 'u1',
        type: 'VERIFY_EMAIL',
        consumedAt: null,
        expiresAt: dayFromNow(),
      },
    ];
    state.userRow = {
      id: 'u1',
      email: 'user@example.com',
      displayName: '张三',
      role: 'FREE',
      status: 1,
      tokenVersion: 3,
      emailVerifiedAt: null,
    };
    state.userUpdateImpl = () => ({ ...state.userRow });

    getSiteSettingsMock.mockResolvedValue({ jwt_expiry: 7 });
    enforceRateLimitMock.mockResolvedValue(null);
    resolveRequestClientIpMock.mockReturnValue('1.2.3.4');
    sendWelcomeEmailMock.mockResolvedValue({ ok: true });
  });

  const post = (token: string) =>
    POST(
      createJsonRequest('http://localhost/api/auth/verify-email', {
        method: 'POST',
        body: { token },
      })
    );

  it('验证成功：标记 emailVerifiedAt、消费令牌并签发会话', async () => {
    const res = await post(RAW_TOKEN);

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ verified: true });
    expect(res.headers.get('set-cookie')).toContain('lecture-live-token=');
    expect(state.tokens[0].consumedAt).toBeInstanceOf(Date);
    expect(fake.committedOps()).toContain('user.update');
  });

  it('已验证过的账号再点链接：不重复写 emailVerifiedAt，仍放行登录', async () => {
    state.userRow = { ...state.userRow!, emailVerifiedAt: new Date('2026-01-01') };

    const res = await post(RAW_TOKEN);

    expect(res.status).toBe(200);
    expect(fake.committedOps()).not.toContain('user.update');
  });

  // #7 核心回归
  it('标记已验证写库失败时认领整体回滚，链接仍可再次使用', async () => {
    state.userUpdateImpl = () => {
      throw new Error('connection lost');
    };

    const res = await post(RAW_TOKEN);

    expect(res.status).toBe(500);
    expect(fake.committedOps()).not.toContain('emailToken.updateMany');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('账号被封禁时回滚认领（解封后链接在 TTL 内仍可用）', async () => {
    state.userRow = { ...state.userRow!, status: 0 };

    const res = await post(RAW_TOKEN);

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ error: '账号不可用' });
    expect(fake.committedOps()).not.toContain('emailToken.updateMany');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('令牌不存在时拒绝且不写库', async () => {
    const res = await post('nope');

    expect(res.status).toBe(400);
    expect(fake.committed).toHaveLength(0);
  });

  it('令牌已消费过时拒绝（单次使用）', async () => {
    state.tokens[0].consumedAt = new Date();

    const res = await post(RAW_TOKEN);

    expect(res.status).toBe(400);
    expect(fake.committed).toHaveLength(0);
  });

  it('令牌过期时拒绝', async () => {
    state.tokens[0].expiresAt = new Date(Date.now() - 1000);

    const res = await post(RAW_TOKEN);

    expect(res.status).toBe(400);
    expect(fake.committed).toHaveLength(0);
  });

  it('类型不符的令牌（拿重置令牌来验证邮箱）被拒绝', async () => {
    state.tokens[0].type = 'RESET_PASSWORD';

    const res = await post(RAW_TOKEN);

    expect(res.status).toBe(400);
    expect(fake.committed).toHaveLength(0);
  });
});
