import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { siteSettingFindManyMock, siteSettingUpsertMock } = vi.hoisted(() => ({
  siteSettingFindManyMock: vi.fn(),
  siteSettingUpsertMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: { findMany: siteSettingFindManyMock, upsert: siteSettingUpsertMock },
  },
}));

vi.mock('@/lib/crypto', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
}));

import {
  getRechargeSettings,
  updateRechargeSettings,
  toPublicRechargeConfig,
  hasChannelCredentials,
  RechargeSettingsError,
  type RechargeSettings,
} from '@/lib/payment/settings';
import { getPaymentProvider, getCallbackPaymentProvider } from '@/lib/payment';
import { SETTING_SECRET_MASK } from '@/lib/siteSettings';

const full = (o: Partial<RechargeSettings> = {}): RechargeSettings =>
  ({
    enabled: true,
    currencySymbol: '¥',
    currency: 'CNY',
    alipayEnabled: false,
    wechatEnabled: false,
    stripeEnabled: false,
    sandboxEnabled: false,
    alipayAppId: '',
    alipayPrivateKey: '',
    alipayPublicKey: '',
    alipaySellerId: '',
    alipayGateway: '',
    wechatAppId: '',
    wechatMchId: '',
    wechatApiV3Key: '',
    wechatSerialNo: '',
    wechatPrivateKey: '',
    wechatPlatformCert: '',
    stripeSecretKey: '',
    stripeWebhookSecret: '',
    stripePublishableKey: '',
    ...o,
  }) as RechargeSettings;

/** 三条轨各自「收款凭据齐 + 验签凭据缺」的半配置态。 */
const HALF_CONFIGURED = {
  alipay: full({
    alipayEnabled: true,
    alipayAppId: 'app-1',
    alipayPrivateKey: 'k',
    alipayPublicKey: '', // ← 验签凭据缺
  }),
  wechat: full({
    wechatEnabled: true,
    wechatMchId: '160000',
    wechatApiV3Key: 'k'.repeat(32),
    wechatPrivateKey: 'k',
    wechatPlatformCert: '', // ← 验签凭据缺
  }),
  stripe: full({
    stripeEnabled: true,
    stripeSecretKey: 'sk_test_x',
    stripeWebhookSecret: '', // ← 验签凭据缺
  }),
};

beforeEach(() => {
  siteSettingFindManyMock.mockReset();
  siteSettingFindManyMock.mockResolvedValue([]);
  siteSettingUpsertMock.mockReset();
  siteSettingUpsertMock.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('updateRechargeSettings：布尔严格解析（P3-10）', () => {
  const writtenValue = (key: string) =>
    siteSettingUpsertMock.mock.calls.find((c) => c[0].where.key === key)?.[0].create.value;

  it('▶ 字符串 "false" 必须存成 false —— 不能靠 JS 真值性反手把充值系统打开', async () => {
    await updateRechargeSettings({ enabled: 'false' as unknown as boolean });
    expect(writtenValue('recharge_enabled')).toBe('false');
  });

  it('▶ true/"true"/1 与 false/"false"/0 都按字面语义写入', async () => {
    for (const [input, expected] of [
      [true, 'true'],
      ['true', 'true'],
      [1, 'true'],
      [false, 'false'],
      ['false', 'false'],
      [0, 'false'],
    ] as Array<[unknown, string]>) {
      siteSettingUpsertMock.mockClear();
      await updateRechargeSettings({ enabled: input as boolean });
      expect(writtenValue('recharge_enabled')).toBe(expected);
    }
  });

  it('▶ 非布尔取值直接拒（400），绝不猜', async () => {
    await expect(
      updateRechargeSettings({ enabled: 'yes' as unknown as boolean })
    ).rejects.toBeInstanceOf(RechargeSettingsError);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('▶ 非法字段排在合法字段之后时，前面的字段也一个都不许落库（别留半截配置）', async () => {
    await expect(
      updateRechargeSettings({
        enabled: true,
        currencySymbol: '$',
        stripeEnabled: 'maybe' as unknown as boolean,
      })
    ).rejects.toBeInstanceOf(RechargeSettingsError);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });
});

describe('updateRechargeSettings：币种与 Stripe 模式一致性', () => {
  it('▶ 币种必须是 ISO-4217 三字母码；「元」这类自由文本直接拒（P3-15）', async () => {
    await expect(updateRechargeSettings({ currency: '元' })).rejects.toBeInstanceOf(
      RechargeSettingsError
    );
    await updateRechargeSettings({ currency: 'usd' });
    expect(
      siteSettingUpsertMock.mock.calls.find((c) => c[0].where.key === 'recharge_currency')?.[0]
        .create.value
    ).toBe('USD');
  });

  it('▶ 换 sk_live_ 密钥却让 webhook 密钥留掩码 → 拒绝（P3-4 分裂态）', async () => {
    await expect(
      updateRechargeSettings({
        stripeSecretKey: 'sk_live_new',
        stripeWebhookSecret: SETTING_SECRET_MASK,
      })
    ).rejects.toBeInstanceOf(RechargeSettingsError);
  });

  it.each(['sk_live_new', 'rk_live_new'])('▶ %s 与 test webhook 模式不一致 → 拒绝', async (key) => {
    await expect(
      updateRechargeSettings({
        stripeSecretKey: key,
        stripeWebhookSecret: 'whsec_test_old',
      })
    ).rejects.toBeInstanceOf(RechargeSettingsError);
  });

  it('▶ 不动 Stripe 密钥的常规保存不受影响（掩码回存）', async () => {
    await expect(
      updateRechargeSettings({
        alipayEnabled: true,
        stripeSecretKey: SETTING_SECRET_MASK,
        stripeWebhookSecret: SETTING_SECRET_MASK,
      })
    ).resolves.toBeUndefined();
  });
});

describe('SEC-024：生产环境保存 Stripe 配置 fail-closed', () => {
  it.each(['sk_test_new', 'rk_test_new', 'proxy_secret'])(
    '▶ 新存 %s → 拒绝且不写任何字段',
    async (key) => {
      vi.stubEnv('NODE_ENV', 'production');
      await expect(
        updateRechargeSettings({
          stripeSecretKey: key,
          stripeWebhookSecret: 'whsec_current',
        })
      ).rejects.toBeInstanceOf(RechargeSettingsError);
      expect(siteSettingUpsertMock).not.toHaveBeenCalled();
    }
  );

  it.each(['sk_live_new', 'rk_live_new'])('▶ 新存 %s + webhook secret → 允许', async (key) => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(
      updateRechargeSettings({
        stripeSecretKey: key,
        stripeWebhookSecret: 'whsec_current',
      })
    ).resolves.toBeUndefined();
  });

  it('▶ 启用时 key 留掩码：读取现有 test key 后拒绝，不允许历史脏配置复活', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    siteSettingFindManyMock.mockResolvedValue([
      { key: 'recharge_stripe_secret_key', value: 'enc:sk_test_existing' },
    ]);

    await expect(
      updateRechargeSettings({
        stripeEnabled: true,
        stripeSecretKey: SETTING_SECRET_MASK,
        stripeWebhookSecret: SETTING_SECRET_MASK,
      })
    ).rejects.toBeInstanceOf(RechargeSettingsError);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('▶ 启用时 key 留掩码：现有 rk_live key 通过且只在保存请求期读取数据库', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    siteSettingFindManyMock.mockResolvedValue([
      { key: 'recharge_stripe_secret_key', value: 'enc:rk_live_existing' },
    ]);

    await expect(
      updateRechargeSettings({
        stripeEnabled: true,
        stripeSecretKey: SETTING_SECRET_MASK,
        stripeWebhookSecret: SETTING_SECRET_MASK,
      })
    ).resolves.toBeUndefined();
    expect(siteSettingFindManyMock).toHaveBeenCalledTimes(1);
  });

  it('▶ 生产仍可关闭历史 test 配置；开发环境仍可正常保存 test key', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(
      updateRechargeSettings({
        stripeEnabled: false,
        stripeSecretKey: SETTING_SECRET_MASK,
        stripeWebhookSecret: SETTING_SECRET_MASK,
      })
    ).resolves.toBeUndefined();

    vi.stubEnv('NODE_ENV', 'development');
    await expect(
      updateRechargeSettings({
        stripeSecretKey: 'rk_test_local',
        stripeWebhookSecret: 'whsec_local',
      })
    ).resolves.toBeUndefined();
  });
});

describe('getRechargeSettings：脏币种兜底', () => {
  it('▶ 库里是「元」这类历史脏值 → 回落 CNY，绝不外泄给 Stripe', async () => {
    siteSettingFindManyMock.mockResolvedValue([{ key: 'recharge_currency', value: '元' }]);
    expect((await getRechargeSettings()).currency).toBe('CNY');
  });
});

describe('渠道就绪度：验签凭据必须一起算（P3-5）', () => {
  it('▶ hasChannelCredentials：只有收款凭据的半配置 → false', () => {
    expect(hasChannelCredentials(HALF_CONFIGURED.alipay, 'alipay')).toBe(false);
    expect(hasChannelCredentials(HALF_CONFIGURED.wechat, 'wechat')).toBe(false);
    expect(hasChannelCredentials(HALF_CONFIGURED.stripe, 'stripe')).toBe(false);
  });

  it('▶ toPublicRechargeConfig：半配置渠道不得出现在渠道列表里', () => {
    for (const s of Object.values(HALF_CONFIGURED)) {
      expect(toPublicRechargeConfig(s).providers).toEqual([]);
    }
  });

  it('▶ getPaymentProvider：半配置渠道返回 null（下单前就挡住，别让用户白付）', async () => {
    expect(await getPaymentProvider('alipay', HALF_CONFIGURED.alipay)).toBeNull();
    expect(await getPaymentProvider('wechat', HALF_CONFIGURED.wechat)).toBeNull();
    expect(await getPaymentProvider('stripe', HALF_CONFIGURED.stripe)).toBeNull();
  });

  it('▶ 凭据齐全 → 正常装配', async () => {
    const s = full({
      stripeEnabled: true,
      stripeSecretKey: 'sk_test_x',
      stripeWebhookSecret: 'whsec_x',
    });
    expect(await getPaymentProvider('stripe', s)).not.toBeNull();
    expect(toPublicRechargeConfig(s).providers).toEqual(['stripe']);
  });

  it('▶ 公开配置回带 ISO 币种码', () => {
    expect(toPublicRechargeConfig(full({ currency: 'USD' })).currency).toBe('USD');
  });
});

describe('沙箱渠道：生产环境不得出现在公开配置里（P3-5 附带）', () => {
  const s = full({ sandboxEnabled: true });

  it('▶ 生产环境 → 不列出（与 payment/index.ts 的硬护栏一致）', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(toPublicRechargeConfig(s).providers).toEqual([]);
    vi.unstubAllEnvs();
  });

  it('▶ 非生产 → 列出', () => {
    expect(toPublicRechargeConfig(s).providers).toEqual(['sandbox']);
  });
});

describe('SEC-024：公开配置与 checkout/callback provider 共享生产模式门禁', () => {
  const stripe = (secretKey: string) =>
    full({
      stripeEnabled: true,
      stripeSecretKey: secretKey,
      stripeWebhookSecret: 'whsec_x',
      stripePublishableKey: 'pk_configured_x',
    });

  it.each(['sk_test_x', 'rk_test_x', 'proxy_x'])(
    '▶ 生产 %s：不公开、不装配 checkout、也不装配 callback',
    async (key) => {
      vi.stubEnv('NODE_ENV', 'production');
      const s = stripe(key);

      expect(hasChannelCredentials(s, 'stripe')).toBe(false);
      expect(toPublicRechargeConfig(s)).toMatchObject({
        providers: [],
        stripePublishableKey: '',
      });
      expect(await getPaymentProvider('stripe', s)).toBeNull();
      expect(await getCallbackPaymentProvider('stripe', s)).toBeNull();
    }
  );

  it.each(['sk_live_x', 'rk_live_x'])(
    '▶ 生产 %s：完整 live 配置正常公开并双向装配',
    async (key) => {
      vi.stubEnv('NODE_ENV', 'production');
      const s = stripe(key);

      expect(hasChannelCredentials(s, 'stripe')).toBe(true);
      expect(toPublicRechargeConfig(s)).toMatchObject({
        providers: ['stripe'],
        stripePublishableKey: 'pk_configured_x',
      });
      expect(await getPaymentProvider('stripe', s)).not.toBeNull();
      expect(await getCallbackPaymentProvider('stripe', s)).not.toBeNull();
    }
  );

  it('▶ 开发环境的 test key 仍正常公开并双向装配', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const s = stripe('rk_test_local');
    expect(toPublicRechargeConfig(s).providers).toEqual(['stripe']);
    expect(await getPaymentProvider('stripe', s)).not.toBeNull();
    expect(await getCallbackPaymentProvider('stripe', s)).not.toBeNull();
  });
});

describe('回调方向装配：忽略 enabled 开关（P3-11）', () => {
  const paidStripe = full({
    enabled: false, // 总开关已被关掉
    stripeEnabled: false, // 渠道也已停用
    stripeSecretKey: 'sk_test_x',
    stripeWebhookSecret: 'whsec_x',
  });

  it('▶ 停用渠道 / 关总开关后，在途回调仍能装配到 provider', async () => {
    expect(await getCallbackPaymentProvider('stripe', paidStripe)).not.toBeNull();
  });

  it('▶ 但下单方向照旧拒绝（停用即不可再下单）', async () => {
    expect(await getPaymentProvider('stripe', paidStripe)).toBeNull();
  });

  it('▶ 凭据本就不全 → 回调方向也装配不出（验签无从谈起）', async () => {
    expect(await getCallbackPaymentProvider('stripe', HALF_CONFIGURED.stripe)).toBeNull();
  });

  it('▶ 沙箱是唯一无验签渠道，开关仍是它的门禁，不随 P3-11 一起放行', async () => {
    expect(
      await getCallbackPaymentProvider('sandbox', full({ sandboxEnabled: false }))
    ).toBeNull();
    expect(
      await getCallbackPaymentProvider('sandbox', full({ sandboxEnabled: true }))
    ).not.toBeNull();
  });
});
