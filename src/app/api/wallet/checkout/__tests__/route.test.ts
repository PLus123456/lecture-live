import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../tests/utils/http';

const {
  verifyAuthMock,
  enforceRateLimitMock,
  getSiteSettingsMock,
  getRechargeSettingsMock,
  getPaymentProviderMock,
  createPaymentOrderMock,
  spendFromBalanceMock,
  tierFindUniqueMock,
  orderUpdateManyMock,
  createChargeMock,
  linkPaymentProviderObjectsMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  getRechargeSettingsMock: vi.fn(),
  getPaymentProviderMock: vi.fn(),
  createPaymentOrderMock: vi.fn(),
  spendFromBalanceMock: vi.fn(),
  tierFindUniqueMock: vi.fn(),
  orderUpdateManyMock: vi.fn(),
  createChargeMock: vi.fn(),
  linkPaymentProviderObjectsMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/payment/settings', () => ({ getRechargeSettings: getRechargeSettingsMock }));
vi.mock('@/lib/payment', () => ({ getPaymentProvider: getPaymentProviderMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    rechargeTier: { findUnique: tierFindUniqueMock },
    paymentOrder: { updateMany: orderUpdateManyMock },
  },
}));
vi.mock('@/lib/wallet', () => ({
  createPaymentOrder: createPaymentOrderMock,
  spendFromBalance: spendFromBalanceMock,
  DEFAULT_ORDER_CURRENCY: 'CNY',
  ORDER_TTL_MS: 60 * 60_000,
  WalletError: class WalletError extends Error {
    constructor(
      message: string,
      public readonly code: string
    ) {
      super(message);
    }
  },
}));
vi.mock('@/lib/payment/webhookInbox', () => ({
  linkPaymentProviderObjects: linkPaymentProviderObjectsMock,
}));

import { POST } from '@/app/api/wallet/checkout/route';
import { WalletError } from '@/lib/wallet';

// 网关必须拿到与我方 expiresAt 完全相同的截止时间，否则超时支付仍会被收钱、
// 而 creditPaidOrder 判 late_paid 不发任何权益。
const ORDER_EXPIRES_AT = new Date('2026-08-22T13:00:00.000Z');

const TOPUP_TIER = {
  id: 'tier-1',
  kind: 'topup',
  name: '充100',
  priceCents: 10000,
  creditCents: 10000,
  grantRole: null,
  durationDays: null,
  grantMinutes: null,
  active: true,
};

beforeEach(() => {
  verifyAuthMock.mockReset();
  enforceRateLimitMock.mockReset();
  getRechargeSettingsMock.mockReset();
  getPaymentProviderMock.mockReset();
  createPaymentOrderMock.mockReset();
  spendFromBalanceMock.mockReset();
  tierFindUniqueMock.mockReset();
  orderUpdateManyMock.mockReset();
  createChargeMock.mockReset();
  linkPaymentProviderObjectsMock.mockReset().mockResolvedValue(undefined);

  verifyAuthMock.mockResolvedValue({ id: 'u1', email: 'u@x.y', role: 'FREE' });
  enforceRateLimitMock.mockResolvedValue(null);
  getSiteSettingsMock.mockResolvedValue({ site_url: 'http://localhost:3000' });
  getRechargeSettingsMock.mockResolvedValue({
    enabled: true,
    currency: 'CNY',
    currencySymbol: '¥',
  });
  tierFindUniqueMock.mockResolvedValue(TOPUP_TIER);
  createPaymentOrderMock.mockResolvedValue({
    id: 'o1',
    outTradeNo: 'LLTEST',
    amountCents: 10000,
    expiresAt: ORDER_EXPIRES_AT,
  });
  createChargeMock.mockResolvedValue({ payUrl: 'https://pay', providerRef: 'pi_123' });
  getPaymentProviderMock.mockResolvedValue({ name: 'stripe', createCharge: createChargeMock });
  orderUpdateManyMock.mockResolvedValue({ count: 1 });
});

const pay = (body: Record<string, unknown> = {}) =>
  POST(
    createJsonRequest('http://localhost/api/wallet/checkout', {
      method: 'POST',
      body: { tierId: 'tier-1', mode: 'pay', provider: 'stripe', ...body },
    })
  );

describe('checkout：币种端到端绑定（P3-15）', () => {
  // 币种从前只有一个展示用的「货币符号」，Stripe 侧靠它反推、推不出就落 usd —— 管理员填「元」
  // 即静默按美元收款（约 7.1× 超收）。现在 checkout 显式传 ISO 码，并冻结到订单行。
  it('▶ 把配置里的 ISO 币种传给网关并落到订单行', async () => {
    getRechargeSettingsMock.mockResolvedValue({
      enabled: true,
      currency: 'usd',
      currencySymbol: '$',
    });

    await pay();

    expect(createChargeMock).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'USD' })
    );
    expect(createPaymentOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'USD' })
    );
  });

  it('▶ 把订单失效时刻原样下发给网关（不给网关留开口窗）', async () => {
    // 网关侧不设截止时间的话，Stripe Checkout 默认 24h、支付宝 15 天、微信 2h：
    // 用户在我方 expiresAt 之后付款照样被扣钱，而 creditPaidOrder 判 late_paid，
    // 不加余额、不发权益，也没有任何管理端动作能补发。
    await pay();

    expect(createChargeMock).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: ORDER_EXPIRES_AT })
    );
  });

  it('▶ 配置里币种缺失/非法 → 回落 CNY（绝不落成网关默认的 usd）', async () => {
    getRechargeSettingsMock.mockResolvedValue({
      enabled: true,
      currency: '元', // 老站点在自由文本框里填的东西
      currencySymbol: '¥',
    });

    await pay();

    expect(createChargeMock).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'CNY' })
    );
  });
});

describe('checkout：下单落库', () => {
  // P3-14：网关流水号在 createCharge 就拿到了，从前直接丢掉 → Stripe 订单 providerRef 恒 null，
  // 对账时手里只有我方单号。
  it('▶ P3-14 把网关返回的 providerRef 落到订单行', async () => {
    await pay();
    expect(orderUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 'o1', status: 'pending' },
      data: { providerRef: 'pi_123' },
    });
    expect(linkPaymentProviderObjectsMock).toHaveBeenCalledWith({
      provider: 'stripe',
      providerMode: 'unknown',
      providerAccount: 'default',
      orderId: 'o1',
      objectRefs: [{ objectType: 'payment_intent', objectId: 'pi_123' }],
    });
  });

  it('▶ 网关没给 providerRef → 不写空值', async () => {
    createChargeMock.mockResolvedValueOnce({ payUrl: 'https://pay' });
    await pay();
    expect(orderUpdateManyMock).not.toHaveBeenCalled();
  });

  // L16：裸 update 会把一笔「可能已在网关侧建单成功」的订单无条件打成终态 failed。
  it('▶ L16 建单失败的终态化带 status:pending 谓词', async () => {
    createChargeMock.mockRejectedValueOnce(new Error('timeout'));
    const res = await pay();
    expect(res.status).toBe(502);
    expect(orderUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 'o1', status: 'pending' },
      data: { status: 'failed' },
    });
  });
});

describe('checkout：余额结算去抖（L13）', () => {
  // 余额轨不建订单行，没有 outTradeNo @unique 这层兜底：双击/重发就是实打实扣两笔。
  it('▶ 余额购买前先过「同用户同档位」的窄窗限流', async () => {
    tierFindUniqueMock.mockResolvedValue({ ...TOPUP_TIER, kind: 'minutes' });
    spendFromBalanceMock.mockResolvedValue(undefined);

    await POST(
      createJsonRequest('http://localhost/api/wallet/checkout', {
        method: 'POST',
        body: { tierId: 'tier-1', mode: 'balance' },
      })
    );

    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: 'wallet:checkout:balance',
        limit: 1,
        key: 'user:u1:tier:tier-1',
      })
    );
  });

  it('▶ 去抖命中 → 不进入扣款事务', async () => {
    tierFindUniqueMock.mockResolvedValue({ ...TOPUP_TIER, kind: 'minutes' });
    enforceRateLimitMock
      .mockResolvedValueOnce(null) // 通用限流放行
      .mockResolvedValueOnce(new Response('429', { status: 429 })); // 去抖拦下

    await POST(
      createJsonRequest('http://localhost/api/wallet/checkout', {
        method: 'POST',
        body: { tierId: 'tier-1', mode: 'balance' },
      })
    );

    expect(spendFromBalanceMock).not.toHaveBeenCalled();
  });

  it('▶ 冻结账户不得余额购买', async () => {
    tierFindUniqueMock.mockResolvedValue({ ...TOPUP_TIER, kind: 'minutes' });
    spendFromBalanceMock.mockRejectedValue(
      new WalletError('账户存在未处理的支付争议', 'account_frozen')
    );

    const response = await POST(
      createJsonRequest('http://localhost/api/wallet/checkout', {
        method: 'POST',
        body: { tierId: 'tier-1', mode: 'balance' },
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'account_frozen' });
  });
});

describe('SEC-025：拒付冻结账户禁止新支付单', () => {
  it('▶ createPaymentOrder 冻结闸拒绝后不调网关', async () => {
    createPaymentOrderMock.mockRejectedValue(
      new WalletError('账户存在未处理的支付争议', 'account_frozen')
    );

    const response = await pay();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'account_frozen' });
    expect(createChargeMock).not.toHaveBeenCalled();
  });
});

describe('SEC-023：存量 ADMIN 会员档 fail-closed', () => {
  const legacyAdminTier = {
    ...TOPUP_TIER,
    id: 'tier-admin',
    kind: 'membership',
    name: '历史管理员商品',
    grantRole: 'ADMIN',
    durationDays: 30,
    creditCents: null,
  };

  it('▶ 网关下单在建单和调用 Stripe 前拒绝', async () => {
    tierFindUniqueMock.mockResolvedValueOnce(legacyAdminTier);

    const res = await pay({ tierId: 'tier-admin' });

    expect(res.status).toBe(400);
    expect(createPaymentOrderMock).not.toHaveBeenCalled();
    expect(getPaymentProviderMock).not.toHaveBeenCalled();
    expect(createChargeMock).not.toHaveBeenCalled();
  });

  it('▶ 余额购买在限流和扣款事务前拒绝', async () => {
    tierFindUniqueMock.mockResolvedValueOnce(legacyAdminTier);

    const res = await POST(
      createJsonRequest('http://localhost/api/wallet/checkout', {
        method: 'POST',
        body: { tierId: 'tier-admin', mode: 'balance' },
      })
    );

    expect(res.status).toBe(400);
    expect(spendFromBalanceMock).not.toHaveBeenCalled();
    expect(enforceRateLimitMock).toHaveBeenCalledTimes(1); // 仅通用入口限流；不进入余额去抖/扣款
  });
});
