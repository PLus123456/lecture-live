import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyAuthMock, getRechargeSettingsMock, orderFindUniqueMock } = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  getRechargeSettingsMock: vi.fn(),
  orderFindUniqueMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/payment/settings', () => ({ getRechargeSettings: getRechargeSettingsMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: { paymentOrder: { findUnique: orderFindUniqueMock } },
}));

import { GET } from '@/app/api/wallet/sandbox/pay/route';

const ORDER = {
  id: 'o1',
  userId: 'u1',
  outTradeNo: 'LLSANDBOX',
  amountCents: 10000,
  status: 'pending',
};

beforeEach(() => {
  verifyAuthMock.mockReset();
  getRechargeSettingsMock.mockReset();
  orderFindUniqueMock.mockReset();
  getRechargeSettingsMock.mockResolvedValue({ sandboxEnabled: true, currencySymbol: '¥' });
  orderFindUniqueMock.mockResolvedValue(ORDER);
  verifyAuthMock.mockResolvedValue({ id: 'u1', email: 'u@x.y', role: 'FREE' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const get = () =>
  GET(new Request('http://localhost/api/wallet/sandbox/pay?out_trade_no=LLSANDBOX'));

// P3-12：middleware 把 /api/wallet/sandbox/* 整段放行（回调也在这个前缀下），
// 于是这页从前只凭一个订单号就能拿到任意用户的订单金额与单号 —— 无鉴权信息泄露。
describe('/api/wallet/sandbox/pay 鉴权', () => {
  it('▶ 未登录 → 401（不泄露订单存在与否）', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('LLSANDBOX');
  });

  it('▶ 登录但订单不属于自己 → 404（与「不存在」同码，不给区分手段）', async () => {
    verifyAuthMock.mockResolvedValueOnce({ id: 'other', email: 'o@x.y', role: 'FREE' });
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('LLSANDBOX');
  });

  it('▶ 生产环境一律 404（不管 sandboxEnabled 被谁误开）', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await get();
    expect(res.status).toBe(404);
    // 硬护栏必须排在最前：连配置都不该去读。
    expect(getRechargeSettingsMock).not.toHaveBeenCalled();
  });

  it('▶ 本人 + 非生产 + 沙箱已开 → 正常渲染确认页', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('LLSANDBOX');
  });
});
