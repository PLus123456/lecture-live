import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../tests/utils/http';
import { hashToken } from '@/lib/email/tokens';

/**
 * 本文件刻意**不 mock** @/lib/email/tokens：peek/consume/invalidate 的真实语义
 * （哈希查找、consumedAt=null 守卫、原子认领）都要跑到，否则断言只是在测桩。
 * prisma 用 createFakeTxPrisma 替身，它记录「哪些写入最终提交了」——
 * 「先烧后用」那种写法会表现为：改密失败了，令牌的 consumedAt 却提交了。
 */

const RAW_TOKEN = 'raw-reset-token';
const OTHER_TOKEN_ID = 'tok-verify';

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
  status: number;
  emailVerifiedAt: Date | null;
};

// vi.mock 工厂会被提升到 import 之上，所以替身必须在 vi.hoisted 里建（连同它读的可变状态，
// 否则 hoisted 闭包引用模块级 let 会撞 TDZ）。
const {
  fake,
  state,
  getSiteSettingsMock,
  enforceRateLimitMock,
  logActionMock,
  resolveRequestClientIpMock,
  sendSecurityAlertEmailMock,
  bcryptHashMock,
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
        where: { id?: string; userId?: string; consumedAt: null; expiresAt?: { gt: Date } };
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
    sendSecurityAlertEmailMock: v.fn(),
    bcryptHashMock: v.fn(async () => 'hashed-password'),
  };
});

vi.mock('bcryptjs', () => ({ default: { hash: bcryptHashMock } }));

vi.mock('@/lib/prisma', () => ({ prisma: fake.client }));
vi.mock('@/lib/auth', () => ({ validatePassword: vi.fn().mockReturnValue(null) }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/auditLog', () => ({ logAction: logActionMock }));
vi.mock('@/lib/clientIp', () => ({ resolveRequestClientIp: resolveRequestClientIpMock }));
vi.mock('@/lib/email', () => ({ sendSecurityAlertEmail: sendSecurityAlertEmailMock }));

import { POST } from '@/app/api/auth/reset-password/route';

const hourFromNow = () => new Date(Date.now() + 60 * 60_000);

describe('POST /api/auth/reset-password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.reset();

    state.tokens = [
      {
        id: 'tok-reset',
        tokenHash: hashToken(RAW_TOKEN),
        userId: 'u1',
        type: 'RESET_PASSWORD',
        consumedAt: null,
        expiresAt: hourFromNow(),
      },
      // 同一用户名下一枚未用的验证令牌：verify-email 消费后直接签发会话，
      // 改密后必须一并作废，否则等于给刚重置完的账号留了一枚免密登录链接。
      {
        id: OTHER_TOKEN_ID,
        tokenHash: hashToken('raw-verify-token'),
        userId: 'u1',
        type: 'VERIFY_EMAIL',
        consumedAt: null,
        expiresAt: hourFromNow(),
      },
    ];
    state.userRow = {
      id: 'u1',
      email: 'user@example.com',
      displayName: '张三',
      status: 1,
      emailVerifiedAt: null,
    };
    state.userUpdateImpl = () => ({ ...state.userRow });

    getSiteSettingsMock.mockResolvedValue({ bcrypt_rounds: 4, password_min_length: 8 });
    enforceRateLimitMock.mockResolvedValue(null);
    resolveRequestClientIpMock.mockReturnValue('1.2.3.4');
    sendSecurityAlertEmailMock.mockResolvedValue({ ok: true });
    bcryptHashMock.mockResolvedValue('hashed-password');
  });

  const post = (body: unknown) =>
    POST(
      createJsonRequest('http://localhost/api/auth/reset-password', {
        method: 'POST',
        body,
      })
    );

  const tokenById = (id: string) => state.tokens.find((t) => t.id === id)!;

  it('重置成功：改密 + tokenVersion++ + 回填 emailVerifiedAt，令牌被消费', async () => {
    const res = await post({ token: RAW_TOKEN, password: 'NewPassw0rd!' });

    expect(res.status).toBe(200);
    const updateArgs = fake.committed.find((w) => w.op === 'user.update')!
      .args as { data: Record<string, unknown> };
    expect(updateArgs.data.tokenVersion).toEqual({ increment: 1 });
    expect(updateArgs.data.emailVerifiedAt).toBeInstanceOf(Date);
    expect(updateArgs.data.passwordHash).toEqual(expect.any(String));
    expect(tokenById('tok-reset').consumedAt).toBeInstanceOf(Date);
  });

  it('重置成功时一并作废该用户未用的验证令牌', async () => {
    await post({ token: RAW_TOKEN, password: 'NewPassw0rd!' });
    expect(tokenById(OTHER_TOKEN_ID).consumedAt).toBeInstanceOf(Date);
  });

  // #7 核心回归：认领必须与改密同进同退。
  it('改密写库失败时令牌认领整体回滚，同一链接仍可再次使用', async () => {
    state.userUpdateImpl = () => {
      throw new Error('connection lost');
    };

    const res = await post({ token: RAW_TOKEN, password: 'NewPassw0rd!' });

    expect(res.status).toBe(500);
    // 认领写入不得提交——否则这枚令牌就永久报废了
    expect(fake.committedOps()).not.toContain('emailToken.updateMany');
    expect(fake.committedOps()).not.toContain('user.update');
  });

  it('账号被封禁时回滚认领（解封后链接在 TTL 内仍可用）', async () => {
    state.userRow = { ...state.userRow!, status: 0 };

    const res = await post({ token: RAW_TOKEN, password: 'NewPassw0rd!' });

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ error: '账号不可用' });
    expect(fake.committedOps()).not.toContain('emailToken.updateMany');
    expect(fake.committedOps()).not.toContain('user.update');
  });

  it('令牌无效时直接拒，不做任何写入', async () => {
    const res = await post({ token: 'wrong-token', password: 'NewPassw0rd!' });

    expect(res.status).toBe(400);
    expect(fake.committed).toHaveLength(0);
  });

  // bcrypt 排在令牌校验之前的话，任何人都能拿垃圾令牌当免费 CPU 放大器
  // （rounds 上限 15，单次可达秒级；IP 解析失败时限流还整个不生效）。
  it('令牌无效时不跑 bcrypt', async () => {
    await post({ token: 'wrong-token', password: 'NewPassw0rd!' });
    expect(bcryptHashMock).not.toHaveBeenCalled();
  });

  it('令牌有效时才跑 bcrypt', async () => {
    await post({ token: RAW_TOKEN, password: 'NewPassw0rd!' });
    expect(bcryptHashMock).toHaveBeenCalledTimes(1);
  });

  it('令牌已被消费过时拒绝（单次使用）', async () => {
    tokenById('tok-reset').consumedAt = new Date();

    const res = await post({ token: RAW_TOKEN, password: 'NewPassw0rd!' });

    expect(res.status).toBe(400);
    expect(fake.committed).toHaveLength(0);
  });

  it('令牌过期时拒绝', async () => {
    tokenById('tok-reset').expiresAt = new Date(Date.now() - 1000);

    const res = await post({ token: RAW_TOKEN, password: 'NewPassw0rd!' });

    expect(res.status).toBe(400);
    expect(fake.committed).toHaveLength(0);
  });

  it('类型不符的令牌（拿验证令牌来重置）被拒绝', async () => {
    const res = await post({ token: 'raw-verify-token', password: 'NewPassw0rd!' });

    expect(res.status).toBe(400);
    expect(fake.committed).toHaveLength(0);
  });
});
