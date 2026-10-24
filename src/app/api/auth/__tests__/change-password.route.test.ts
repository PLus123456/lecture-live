import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../tests/utils/http';

/**
 * 自助改密的原子性：改密（新哈希 + tokenVersion++ + 作废邮件令牌）、撤销当前 family、
 * 签发新 family 必须同进同退。旧实现三步各自提交——后两步任一步瞬时失败就回 500，
 * 而密码其实已经改了、当前设备在内的所有会话都已失效，前端却提示「修改失败」。
 *
 * 这里的 prisma 是一个最小的「可回滚」内存实现：$transaction 在副本上执行回调，
 * 只有回调成功才整体提交；事务外的调用直接改真状态——与真实数据库的提交语义一致。
 */

const h = vi.hoisted(() => {
  interface UserRow {
    id: string;
    email: string;
    role: 'FREE' | 'PRO' | 'ADMIN';
    status: number;
    tokenVersion: number;
    passwordHash: string;
  }
  interface FamilyRow {
    id: string;
    userId: string;
    currentJtiHash: string;
    generation: number;
    sessionStartedAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
    revokedReason: string | null;
  }
  interface State {
    users: Map<string, UserRow>;
    families: Map<string, FamilyRow>;
    emailTokens: Array<{ userId: string; consumedAt: Date | null }>;
  }

  const db = {
    state: {
      users: new Map(),
      families: new Map(),
      emailTokens: [],
    } as State,
    failFamilyCreate: false,
  };

  function pick<T extends object>(row: T, select?: Record<string, boolean>) {
    if (!select) return { ...row };
    return Object.fromEntries(
      Object.entries(row).filter(([key]) => select[key])
    ) as Partial<T>;
  }

  function delegates(state: State) {
    return {
      user: {
        findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
          const row = where.id
            ? state.users.get(where.id)
            : [...state.users.values()].find((u) => u.email === where.email);
          return row ? { ...row } : null;
        },
        update: async ({
          where,
          data,
          select,
        }: {
          where: { id: string };
          data: { passwordHash?: string; tokenVersion?: { increment: number } };
          select?: Record<string, boolean>;
        }) => {
          const row = state.users.get(where.id);
          if (!row) throw new Error('Record to update not found');
          if (data.passwordHash !== undefined) row.passwordHash = data.passwordHash;
          if (data.tokenVersion) row.tokenVersion += data.tokenVersion.increment;
          return pick(row, select);
        },
      },
      emailToken: {
        updateMany: async ({
          where,
          data,
        }: {
          where: { userId: string };
          data: { consumedAt: Date };
        }) => {
          let count = 0;
          for (const token of state.emailTokens) {
            if (token.userId === where.userId && token.consumedAt === null) {
              token.consumedAt = data.consumedAt;
              count += 1;
            }
          }
          return { count };
        },
      },
      authTokenFamily: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const row = state.families.get(where.id);
          return row ? { ...row } : null;
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: { id: string; userId: string; revokedAt?: null };
          data: Partial<FamilyRow>;
        }) => {
          const row = state.families.get(where.id);
          if (
            !row ||
            row.userId !== where.userId ||
            (where.revokedAt === null && row.revokedAt !== null)
          ) {
            return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
        },
        create: async ({ data }: { data: Omit<FamilyRow, 'revokedAt' | 'revokedReason'> }) => {
          if (db.failFamilyCreate) {
            throw new Error("P1001: Can't reach database server");
          }
          state.families.set(data.id, { ...data, revokedAt: null, revokedReason: null });
          return { ...data };
        },
      },
    };
  }

  // 事务外的 delegate 每次调用都指向「当前已提交」的状态。
  const live = <K extends keyof ReturnType<typeof delegates>>(model: K) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) =>
          (...args: unknown[]) =>
            (
              delegates(db.state)[model] as Record<string, (...a: unknown[]) => unknown>
            )[method](...args),
      }
    );

  const prisma = {
    user: live('user'),
    emailToken: live('emailToken'),
    authTokenFamily: live('authTokenFamily'),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const draft = structuredClone(db.state);
      const result = await fn(delegates(draft));
      db.state = draft;
      return result;
    },
  };

  return { db, prisma, verifyAuthSessionMock: vi.fn() };
});

vi.mock('@/lib/prisma', () => ({ prisma: h.prisma }));
vi.mock('@/lib/redis', () => ({ getRedisClient: () => null }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));
vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: vi.fn().mockResolvedValue({
    bcrypt_rounds: 4,
    password_min_length: 8,
    jwt_expiry: 7,
    rate_limit_auth: 5,
  }),
}));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, verifyAuthSession: h.verifyAuthSessionMock };
});

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { POST } from '@/app/api/auth/change-password/route';
import { signToken, type AuthTokenPayload } from '@/lib/auth';

const OLD_PASSWORD = 'OldPassw0rd!';
const NEW_PASSWORD = 'NewPassw0rd!';
const DAY = 24 * 60 * 60 * 1000;

let originalHash: string;

function seed() {
  const sessionStartedAt = Date.now() - DAY;
  h.db.failFamilyCreate = false;
  h.db.state = {
    users: new Map([
      [
        'u1',
        {
          id: 'u1',
          email: 'user@example.com',
          role: 'FREE' as const,
          status: 1,
          tokenVersion: 3,
          passwordHash: originalHash,
        },
      ],
    ]),
    families: new Map([
      [
        'fam-1',
        {
          id: 'fam-1',
          userId: 'u1',
          currentJtiHash: 'a'.repeat(64),
          generation: 0,
          sessionStartedAt: new Date(sessionStartedAt),
          expiresAt: new Date(sessionStartedAt + 30 * DAY),
          revokedAt: null,
          revokedReason: null,
        },
      ],
    ]),
    emailTokens: [{ userId: 'u1', consumedAt: null }],
  };

  const raw = signToken(
    { id: 'u1', email: 'user@example.com', role: 'FREE', tokenVersion: 3 },
    { sessionStartedAt, familyId: 'fam-1', generation: 0, jti: 'jti-1' }
  );
  h.verifyAuthSessionMock.mockResolvedValue({
    user: { id: 'u1', email: 'user@example.com', role: 'FREE' },
    token: jwt.decode(raw) as AuthTokenPayload,
    rawToken: raw,
  });
}

const changePassword = (body: Record<string, unknown>) =>
  POST(
    createJsonRequest('http://localhost/api/auth/change-password', {
      method: 'POST',
      body,
    })
  );

describe('POST /api/auth/change-password — 改密与会话轮换同进同退', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    originalHash ??= await bcrypt.hash(OLD_PASSWORD, 4);
    seed();
  });

  it('新 family 落库失败时整体回滚：密码、tokenVersion、旧会话、邮件令牌都原样保留', async () => {
    h.db.failFamilyCreate = true;

    const res = await changePassword({
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.headers.get('set-cookie')).toBeNull();
    const user = h.db.state.users.get('u1')!;
    expect(user.passwordHash).toBe(originalHash);
    expect(user.tokenVersion).toBe(3);
    expect(h.db.state.families.get('fam-1')!.revokedAt).toBeNull();
    expect(h.db.state.emailTokens[0].consumedAt).toBeNull();
    // 失败提示如实：旧密码依旧可用
    await expect(bcrypt.compare(OLD_PASSWORD, user.passwordHash)).resolves.toBe(true);
  });

  it('成功时一次提交：新哈希 + tokenVersion++ + 撤旧 family + 新 family，并下发新 cookie', async () => {
    const res = await changePassword({
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(200);
    const body = await readJson<{ sessionBinding?: string }>(res);
    expect(typeof body.sessionBinding).toBe('string');
    expect(res.headers.get('set-cookie')).toContain('lecture-live-token=');

    const user = h.db.state.users.get('u1')!;
    await expect(bcrypt.compare(NEW_PASSWORD, user.passwordHash)).resolves.toBe(true);
    expect(user.tokenVersion).toBe(4);
    expect(h.db.state.families.get('fam-1')).toMatchObject({
      revokedReason: 'password_change',
    });
    expect(h.db.state.families.get('fam-1')!.revokedAt).toBeInstanceOf(Date);
    expect(h.db.state.emailTokens[0].consumedAt).toBeInstanceOf(Date);

    const issued = [...h.db.state.families.values()].filter((f) => f.id !== 'fam-1');
    expect(issued).toHaveLength(1);
    const cookieToken = /lecture-live-token=([^;]+)/.exec(
      res.headers.get('set-cookie') ?? ''
    )?.[1];
    const payload = jwt.decode(cookieToken ?? '') as AuthTokenPayload;
    expect(payload).toMatchObject({ tokenVersion: 4, familyId: issued[0].id, generation: 0 });
  });

  it('当前密码错误：403，且什么都不改', async () => {
    const res = await changePassword({
      currentPassword: 'WrongPassw0rd!',
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(403);
    expect(h.db.state.users.get('u1')!.passwordHash).toBe(originalHash);
    expect(h.db.state.families.size).toBe(1);
  });

  it('非字符串口令回 400 而不是 bcrypt 抛错后的 500', async () => {
    const res = await changePassword({ currentPassword: 12345678, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });
});
