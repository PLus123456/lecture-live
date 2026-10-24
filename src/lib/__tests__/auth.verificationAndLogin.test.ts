import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 两组 auth 真源不变量：
 *  1. 认证查询本身失败（DB 故障）必须抛出、由路由落成 5xx，不能伪装成「未登录」null → 401：
 *     前端 AuthSessionMonitor 会把任何 401 当会话失效，登出并持久撤销仍然有效的 token family。
 *  2. login() 只认与入参逐字符一致的账号：email 列是 utf8mb4_unicode_ci，重音 / 全角写法会
 *     查到同一行，却各自换出新的按邮箱限流桶；账号级桶（beforePasswordCheck）必须在 bcrypt 前判定。
 */

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  familyFindUnique: vi.fn(),
  familyCreate: vi.fn(),
  siteSettingFindUnique: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique, create: mocks.userCreate },
    authTokenFamily: {
      findUnique: mocks.familyFindUnique,
      create: mocks.familyCreate,
    },
    siteSetting: { findUnique: mocks.siteSettingFindUnique },
  },
}));
vi.mock('@/lib/redis', () => ({ getRedisClient: () => null }));
vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: async () => ({
    chat_files_quota_free_mb: 100,
    chat_files_quota_pro_mb: 1024,
    chat_files_quota_admin_mb: 10240,
  }),
}));

import bcrypt from 'bcryptjs';
import {
  LOGIN_THROTTLED_ERROR,
  isAuthVerificationInfrastructureError,
  issueAuthToken,
  login,
  registerWithOptions,
  verifyAuth,
  verifyAuthSession,
  verifyAuthToken,
} from '@/lib/auth';

const USER = {
  id: 'user-1',
  email: 'victim@uni.edu',
  role: 'PRO' as const,
  tokenVersion: 0,
};

function bearer(token: string): Request {
  return new Request('http://localhost/api/anything', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('认证查询故障不得被映射成「未登录」', () => {
  let token: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.familyCreate.mockResolvedValue({});
    token = await issueAuthToken(USER);
    const poolTimeout = new Error(
      'P2024: Timed out fetching a new connection from the connection pool'
    );
    mocks.userFindUnique.mockRejectedValue(poolTimeout);
    mocks.familyFindUnique.mockRejectedValue(poolTimeout);
  });

  it('verifyAuthSession / verifyAuth 抛出基础设施错误，而不是返回 null（→ 401）', async () => {
    const sessionError = await verifyAuthSession(bearer(token)).then(
      () => null,
      (error: unknown) => error
    );
    expect(sessionError).not.toBeNull();
    expect(isAuthVerificationInfrastructureError(sessionError)).toBe(true);

    await expect(verifyAuth(bearer(token))).rejects.toSatisfy(
      isAuthVerificationInfrastructureError
    );
  });

  it('真无效的 token 仍返回 null（不是把所有失败都改成抛错）', async () => {
    await expect(verifyAuthSession(bearer('not-a-jwt'))).resolves.toBeNull();
    await expect(
      verifyAuthSession(new Request('http://localhost/api/anything'))
    ).resolves.toBeNull();
  });

  it('verifyAuthToken（WS 握手 / SSR 首页）保持原口径：故障时返回 null', async () => {
    await expect(verifyAuthToken(token)).resolves.toBeNull();
  });
});

describe('login：排序规则等价写法与账号级限流', () => {
  const PASSWORD = 'Correct-horse-1';
  let passwordHash: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    passwordHash = await bcrypt.hash(PASSWORD, 4);
    mocks.familyCreate.mockResolvedValue({});
  });

  function row(email: string) {
    return {
      id: 'user-1',
      email,
      role: 'PRO',
      tokenVersion: 0,
      status: 1,
      emailVerifiedAt: new Date(),
      passwordHash,
    };
  }

  it('DB 按 utf8mb4_unicode_ci 命中的重音变体不得触达真实账号的口令比对', async () => {
    // MySQL 下 'vïctim@uni.edu' = 'victim@uni.edu'：findUnique 返回的是受害者那一行
    mocks.userFindUnique.mockResolvedValue(row('victim@uni.edu'));
    const beforePasswordCheck = vi.fn().mockResolvedValue(true);
    const compareSpy = vi.spyOn(bcrypt, 'compare');

    await expect(
      login('vïctim@uni.edu', PASSWORD, { beforePasswordCheck })
    ).rejects.toThrow('Invalid credentials');

    // 按「账号不存在」处理：不计账号桶、不签会话，比对的是哑 hash（时序与不存在一致）
    expect(beforePasswordCheck).not.toHaveBeenCalled();
    expect(mocks.familyCreate).not.toHaveBeenCalled();
    expect(compareSpy).toHaveBeenCalledTimes(1);
    expect(compareSpy.mock.calls[0][1]).not.toBe(passwordHash);
    compareSpy.mockRestore();
  });

  it('大小写 / 首尾空白差异仍视为同一账号（存量大写邮箱不被锁在门外）', async () => {
    mocks.userFindUnique.mockResolvedValue(row(' Victim@Uni.EDU '));

    const result = await login('victim@uni.edu', PASSWORD);
    expect(result.user.id).toBe('user-1');
  });

  it('账号级桶在 bcrypt 之前按 user.id 判定；命中时抛限流哨兵且不比对口令', async () => {
    mocks.userFindUnique.mockResolvedValue(row('victim@uni.edu'));
    const beforePasswordCheck = vi.fn().mockResolvedValue(false);
    const compareSpy = vi.spyOn(bcrypt, 'compare');

    await expect(
      login('victim@uni.edu', PASSWORD, { beforePasswordCheck })
    ).rejects.toThrow(LOGIN_THROTTLED_ERROR);

    expect(beforePasswordCheck).toHaveBeenCalledWith('user-1');
    expect(compareSpy).not.toHaveBeenCalled();
    expect(mocks.familyCreate).not.toHaveBeenCalled();
    compareSpy.mockRestore();
  });

  it('账号不存在时不调用账号级桶（不制造额外的存在性信号）', async () => {
    mocks.userFindUnique.mockResolvedValue(null);
    const beforePasswordCheck = vi.fn().mockResolvedValue(true);

    await expect(
      login('nobody@uni.edu', PASSWORD, { beforePasswordCheck })
    ).rejects.toThrow('Invalid credentials');
    expect(beforePasswordCheck).not.toHaveBeenCalled();
  });
});

describe('registerWithOptions：需邮箱验证时不签会话', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.siteSettingFindUnique.mockResolvedValue(null);
    mocks.userCreate.mockImplementation(async ({ data }) => ({
      id: 'new-user',
      tokenVersion: 0,
      ...data,
    }));
    mocks.familyCreate.mockResolvedValue({});
  });

  it('issueSession=false：不建 AuthTokenFamily、不签 token', async () => {
    const { user, token } = await registerWithOptions(
      'new@uni.edu',
      'Passw0rd-x',
      '新同学',
      { bcryptRounds: 4, emailVerified: false, issueSession: false }
    );
    expect(user.id).toBe('new-user');
    expect(token).toBeNull();
    expect(mocks.familyCreate).not.toHaveBeenCalled();
  });

  it('默认仍签发会话（历史行为不变）', async () => {
    const { token } = await registerWithOptions('new@uni.edu', 'Passw0rd-x', '新同学', {
      bcryptRounds: 4,
    });
    expect(typeof token).toBe('string');
    expect(mocks.familyCreate).toHaveBeenCalledTimes(1);
  });
});
