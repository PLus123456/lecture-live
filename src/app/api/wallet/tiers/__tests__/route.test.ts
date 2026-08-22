import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyAuthMock, tierFindManyMock } = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  tierFindManyMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: { rechargeTier: { findMany: tierFindManyMock } },
}));

import { GET } from '@/app/api/wallet/tiers/route';

beforeEach(() => {
  verifyAuthMock.mockReset();
  tierFindManyMock.mockReset();
  verifyAuthMock.mockResolvedValue({ id: 'u1', email: 'u@example.com', role: 'FREE' });
});

describe('SEC-023：公开商品列表过滤存量 ADMIN 档位', () => {
  it('▶ 不返回 membership + ADMIN，普通会员/分钟档保持兼容', async () => {
    tierFindManyMock.mockResolvedValue([
      {
        id: 'legacy-admin',
        kind: 'membership',
        name: '历史管理员商品',
        priceCents: 100,
        grantRole: 'ADMIN',
        durationDays: 30,
        grantMinutes: null,
        creditCents: null,
      },
      {
        id: 'pro',
        kind: 'membership',
        name: 'PRO 月卡',
        priceCents: 3000,
        grantRole: 'PRO',
        durationDays: 30,
        grantMinutes: null,
        creditCents: null,
      },
      {
        id: 'minutes',
        kind: 'minutes',
        name: '600 分钟',
        priceCents: 5000,
        grantRole: null,
        durationDays: null,
        grantMinutes: 600,
        creditCents: null,
      },
    ]);

    const res = await GET(new Request('http://localhost/api/wallet/tiers'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tiers.map((tier: { id: string }) => tier.id)).toEqual(['pro', 'minutes']);
    expect(tierFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true } })
    );
  });
});
