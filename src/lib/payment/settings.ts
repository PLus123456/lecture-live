import 'server-only';

import { prisma } from '@/lib/prisma';
import { encrypt, decrypt } from '@/lib/crypto';
import { SETTING_SECRET_MASK } from '@/lib/siteSettings';
import type { PaymentProviderName } from '@/lib/payment/types';
import {
  getStripeKeyMode,
  isStripeKeyAllowedForEnvironment,
} from '@/lib/payment/stripeMode';

/**
 * 充值系统配置（货币 + 各支付渠道开关与凭据）。存于 SiteSetting 的 `recharge_*` 键。
 * 敏感凭据（私钥/密钥）加密落库；admin GET 只回脱敏占位。与站点其它设置隔离，
 * 不污染 `siteSettings.ts` 的 SiteSettings 大接口——充值配置项多且专用。
 */
export interface RechargeSettings {
  enabled: boolean; // 充值系统总开关
  currencySymbol: string; // 货币符号（**仅展示**），默认 ¥
  /**
   * 结算币种（ISO-4217 大写码，默认 CNY）。P3-15：币种必须是显式配置，绝不从 currencySymbol
   * 反推——旧实现「猜不出就 usd」使管理员填「元」时按美元收款、约 7.1× 超收。
   */
  currency: string;
  // 各渠道启用开关
  alipayEnabled: boolean;
  wechatEnabled: boolean;
  stripeEnabled: boolean;
  sandboxEnabled: boolean; // 开发/测试沙箱渠道（生产应关）
  // 支付宝（电脑网站支付）
  alipayAppId: string;
  alipayPrivateKey: string; // 敏感：应用私钥（PKCS8）
  alipayPublicKey: string; // 支付宝公钥（验签用，非敏感）
  alipaySellerId: string; // 商户 PID（收款方，验回调 seller_id 用；留空则不校验）
  alipayGateway: string;
  // 微信支付（Native v3）
  wechatAppId: string;
  wechatMchId: string;
  wechatApiV3Key: string; // 敏感：APIv3 密钥
  wechatSerialNo: string; // 商户证书序列号
  wechatPrivateKey: string; // 敏感：商户 API 私钥（PEM）
  wechatPlatformCert: string; // 微信支付平台证书（验签用，非敏感）
  // Stripe
  stripeSecretKey: string; // 敏感
  stripeWebhookSecret: string; // 敏感
  stripePublishableKey: string; // 公钥（前端可见，非敏感）
}

const KEY_PREFIX = 'recharge_';
const DEFAULT_ALIPAY_GATEWAY = 'https://openapi.alipay.com/gateway.do';
const DEFAULT_CURRENCY = '¥';
const DEFAULT_CURRENCY_CODE = 'CNY';

/** 充值配置写入被拒（非法取值）。路由应据此回 400 而非 500。 */
export class RechargeSettingsError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'RechargeSettingsError';
  }
}

/** ISO-4217 字母码（三位大写字母）。不做白名单——各网关支持的币种集合各不相同且会变。 */
const ISO4217_RE = /^[A-Z]{3}$/;

export function normalizeCurrencyCode(v: unknown): string | null {
  const code = String(v ?? '').trim().toUpperCase();
  return ISO4217_RE.test(code) ? code : null;
}

/** 敏感字段（加密落库 + 脱敏回传）。 */
const SECRET_FIELDS = [
  'alipayPrivateKey',
  'wechatApiV3Key',
  'wechatPrivateKey',
  'stripeSecretKey',
  'stripeWebhookSecret',
] as const;

type FieldKind = 'string' | 'bool' | 'secret' | 'currency';
const FIELD_MAP: Array<{ field: keyof RechargeSettings; key: string; kind: FieldKind }> = [
  { field: 'enabled', key: 'recharge_enabled', kind: 'bool' },
  { field: 'currencySymbol', key: 'recharge_currency_symbol', kind: 'string' },
  { field: 'currency', key: 'recharge_currency', kind: 'currency' },
  { field: 'alipayEnabled', key: 'recharge_alipay_enabled', kind: 'bool' },
  { field: 'wechatEnabled', key: 'recharge_wechat_enabled', kind: 'bool' },
  { field: 'stripeEnabled', key: 'recharge_stripe_enabled', kind: 'bool' },
  { field: 'sandboxEnabled', key: 'recharge_sandbox_enabled', kind: 'bool' },
  { field: 'alipayAppId', key: 'recharge_alipay_app_id', kind: 'string' },
  { field: 'alipayPrivateKey', key: 'recharge_alipay_private_key', kind: 'secret' },
  { field: 'alipayPublicKey', key: 'recharge_alipay_public_key', kind: 'string' },
  { field: 'alipaySellerId', key: 'recharge_alipay_seller_id', kind: 'string' },
  { field: 'alipayGateway', key: 'recharge_alipay_gateway', kind: 'string' },
  { field: 'wechatAppId', key: 'recharge_wechat_app_id', kind: 'string' },
  { field: 'wechatMchId', key: 'recharge_wechat_mch_id', kind: 'string' },
  { field: 'wechatApiV3Key', key: 'recharge_wechat_apiv3_key', kind: 'secret' },
  { field: 'wechatSerialNo', key: 'recharge_wechat_serial_no', kind: 'string' },
  { field: 'wechatPrivateKey', key: 'recharge_wechat_private_key', kind: 'secret' },
  { field: 'wechatPlatformCert', key: 'recharge_wechat_platform_cert', kind: 'string' },
  { field: 'stripeSecretKey', key: 'recharge_stripe_secret_key', kind: 'secret' },
  { field: 'stripeWebhookSecret', key: 'recharge_stripe_webhook_secret', kind: 'secret' },
  { field: 'stripePublishableKey', key: 'recharge_stripe_publishable_key', kind: 'string' },
];

function decryptSafe(value: string | undefined): string {
  if (!value) return '';
  try {
    return decrypt(value);
  } catch {
    return '';
  }
}

/** 读取充值配置（解密敏感字段）。供 checkout / callback / admin 消费。 */
export async function getRechargeSettings(): Promise<RechargeSettings> {
  const rows = await prisma.siteSetting.findMany({
    where: { key: { startsWith: KEY_PREFIX } },
  });
  const raw: Record<string, string> = {};
  for (const r of rows) raw[r.key] = r.value;

  const bool = (k: string, d: boolean) =>
    raw[k] === undefined ? d : raw[k] === 'true' || raw[k] === '1';
  const str = (k: string, d: string) =>
    raw[k] !== undefined && raw[k] !== '' ? raw[k] : d;

  return {
    enabled: bool('recharge_enabled', false),
    currencySymbol: str('recharge_currency_symbol', DEFAULT_CURRENCY),
    // 落库值理论上已被 updateRechargeSettings 校验过，但历史行/人工改库可能是脏的 → 再兜一次。
    currency:
      normalizeCurrencyCode(raw['recharge_currency']) ?? DEFAULT_CURRENCY_CODE,
    alipayEnabled: bool('recharge_alipay_enabled', false),
    wechatEnabled: bool('recharge_wechat_enabled', false),
    stripeEnabled: bool('recharge_stripe_enabled', false),
    sandboxEnabled: bool('recharge_sandbox_enabled', false),
    alipayAppId: str('recharge_alipay_app_id', ''),
    alipayPrivateKey: decryptSafe(raw['recharge_alipay_private_key']),
    alipayPublicKey: str('recharge_alipay_public_key', ''),
    alipaySellerId: str('recharge_alipay_seller_id', ''),
    alipayGateway: str('recharge_alipay_gateway', DEFAULT_ALIPAY_GATEWAY),
    wechatAppId: str('recharge_wechat_app_id', ''),
    wechatMchId: str('recharge_wechat_mch_id', ''),
    wechatApiV3Key: decryptSafe(raw['recharge_wechat_apiv3_key']),
    wechatSerialNo: str('recharge_wechat_serial_no', ''),
    wechatPrivateKey: decryptSafe(raw['recharge_wechat_private_key']),
    wechatPlatformCert: str('recharge_wechat_platform_cert', ''),
    stripeSecretKey: decryptSafe(raw['recharge_stripe_secret_key']),
    stripeWebhookSecret: decryptSafe(raw['recharge_stripe_webhook_secret']),
    stripePublishableKey: str('recharge_stripe_publishable_key', ''),
  };
}

/**
 * 严格布尔解析（P3-10）。绝不用 JS 真值性：`"false"` 是**真值**，旧实现的 `v ? 'true' : 'false'`
 * 会把 `PUT {"enabled":"false"}` 存成 'true' —— 想关闭充值系统的动作反而把它打开了。
 * 只认真正的布尔语义，其余一律拒绝而不是猜。
 */
function strictBool(field: string, v: unknown): boolean {
  if (v === true || v === 'true' || v === 1) return true;
  if (v === false || v === 'false' || v === 0) return false;
  throw new RechargeSettingsError(`${field} 必须是布尔值`);
}

/** 写入充值配置（部分更新）。敏感字段收到掩码/空串 = 保持原值（不清密钥）。 */
export async function updateRechargeSettings(
  patch: Partial<RechargeSettings>
): Promise<void> {
  assertStripeKeyModeConsistency(patch);
  await assertStripeProductionConfiguration(patch);

  // 先整份校验、再统一落库：校验一旦中途抛错就写了一半，配置会停在自相矛盾的中间态。
  const pending: Array<{ key: string; value: string }> = [];
  for (const { field, key, kind } of FIELD_MAP) {
    const v = patch[field];
    if (v === undefined) continue;
    let value: string;
    if (kind === 'bool') {
      value = strictBool(field, v) ? 'true' : 'false';
    } else if (kind === 'currency') {
      const code = normalizeCurrencyCode(v);
      if (!code) {
        throw new RechargeSettingsError(`${field} 必须是 ISO-4217 三字母币种码（如 CNY）`);
      }
      value = code;
    } else if (kind === 'secret') {
      // 掩码或空 = 保持原值不变（避免脱敏值被回存导致密钥被清空）
      if (v === SETTING_SECRET_MASK || v === '') continue;
      value = encrypt(String(v));
    } else {
      value = String(v);
    }
    pending.push({ key, value });
  }

  await Promise.all(
    pending.map(({ key, value }) =>
      prisma.siteSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      })
    )
  );
}

/**
 * P3-4（保存侧一半）：拒绝 secretKey 与 webhookSecret 的模式不一致。
 * 逐字段独立 upsert + 「掩码 = 保持原值」使得「把 sk_test 换成 sk_live、webhook 框不动」
 * 是一次正常保存动作，落成 live 密钥 + test webhook 的分裂态：真实支付永远验签失败（用户
 * 付钱不到账），而测试卡产生的事件反倒是唯一验得过的。掩码字段无法判定模式 → 跳过不误伤。
 */
function suppliedStripeSecret(v: string | undefined): string | null {
  return v === undefined || v === SETTING_SECRET_MASK || v === '' ? null : v;
}

function assertStripeKeyModeConsistency(patch: Partial<RechargeSettings>): void {
  const secret = suppliedStripeSecret(patch.stripeSecretKey);
  if (!secret) return; // 没在改密钥（掩码回存）→ 与本次保存无关

  const secretMode = getStripeKeyMode(secret);
  if (!secretMode) return; // 非标准前缀（自建代理等）→ 无从判定，不阻拦

  // 换密钥就必须同时给出配套的 webhook 签名密钥：whsec_ 本身不带 test/live 段，
  // 无法事后校验一致性，只能靠「同一次保存一起换」把分裂态挡在门外。
  const hook = suppliedStripeSecret(patch.stripeWebhookSecret);
  if (!hook) {
    throw new RechargeSettingsError(
      '更换 Stripe 密钥时必须同时填写对应模式的 Webhook 签名密钥（否则会落成 live 密钥 + test 验签的分裂态）'
    );
  }
  const hookMode = hook.startsWith('whsec_live_')
    ? 'live'
    : hook.startsWith('whsec_test_')
      ? 'test'
      : null;
  if (hookMode && hookMode !== secretMode) {
    throw new RechargeSettingsError(
      'Stripe 密钥与 Webhook 签名密钥的模式不一致（test / live 必须同侧）'
    );
  }
}

/**
 * SEC-024 保存侧门禁：生产环境不得新存 test/未知 key；启用 Stripe 且密钥仍是掩码时，
 * 在本次请求内读取现有值核验。读取发生在显式保存调用中，不在模块加载或 build 阶段连接数据库。
 */
async function assertStripeProductionConfiguration(
  patch: Partial<RechargeSettings>
): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return;

  const suppliedKey = suppliedStripeSecret(patch.stripeSecretKey);
  if (suppliedKey) {
    if (getStripeKeyMode(suppliedKey) !== 'live') {
      throw new RechargeSettingsError('生产环境的 Stripe 密钥必须是 live 模式');
    }
    return;
  }

  if (patch.stripeEnabled === undefined || !strictBool('stripeEnabled', patch.stripeEnabled)) {
    return;
  }

  const current = await getRechargeSettings();
  if (getStripeKeyMode(current.stripeSecretKey) !== 'live') {
    throw new RechargeSettingsError('生产环境启用 Stripe 前必须配置 live 模式密钥');
  }
}

/** admin GET：敏感字段回脱敏占位（已配置→掩码，未配置→空），杜绝明文经 GET 回传。 */
export function serializeRechargeSettingsForAdmin(
  s: RechargeSettings
): RechargeSettings {
  const out: RechargeSettings = { ...s };
  for (const f of SECRET_FIELDS) {
    out[f] = s[f] ? SETTING_SECRET_MASK : '';
  }
  return out;
}

/**
 * 渠道凭据是否**齐全到能跑完整条链路**（P3-5）。
 * 关键在于把「收款凭据」与「验签凭据」一起算：只校验收款侧会让用户真付钱、回调必被拒、
 * 订单永久 pending 且无任何自动补偿——三条轨全是这种 fail-closed 形态。
 */
export function hasChannelCredentials(
  s: RechargeSettings,
  name: PaymentProviderName
): boolean {
  switch (name) {
    case 'alipay':
      // alipayPublicKey 缺失 → verifyAlipaySign 拿空 PEM 抛错 → 回调恒 false。
      return Boolean(s.alipayAppId && s.alipayPrivateKey && s.alipayPublicKey);
    case 'wechat':
      // wechatPlatformCert 缺失 → verifyCallback 第一行就 return null。
      return Boolean(
        s.wechatMchId && s.wechatApiV3Key && s.wechatPrivateKey && s.wechatPlatformCert
      );
    case 'stripe':
      // stripeWebhookSecret 缺失 → verifyCallback 直接 return null。
      // SEC-024：生产环境必须是明确的 live key；test/未知 key 一律视为渠道未就绪。
      return Boolean(
        s.stripeSecretKey &&
          s.stripeWebhookSecret &&
          isStripeKeyAllowedForEnvironment(s.stripeSecretKey)
      );
    case 'sandbox':
      return true; // 沙箱无凭据（可用性由 NODE_ENV + 开关决定）
    default:
      return false;
  }
}

/** 面向普通用户的公开配置（无任何凭据）：货币 + 已启用且已配置的渠道列表。 */
export function toPublicRechargeConfig(s: RechargeSettings): {
  enabled: boolean;
  currencySymbol: string;
  currency: string;
  providers: PaymentProviderName[];
  stripePublishableKey: string;
} {
  const providers: PaymentProviderName[] = [];
  if (s.alipayEnabled && hasChannelCredentials(s, 'alipay')) providers.push('alipay');
  if (s.wechatEnabled && hasChannelCredentials(s, 'wechat')) providers.push('wechat');
  if (s.stripeEnabled && hasChannelCredentials(s, 'stripe')) providers.push('stripe');
  // 与 payment/index.ts 的硬护栏对齐：生产环境即便 DB 开关误开也不列出沙箱，
  // 否则前端列出「沙箱」而用户点了必得 400。
  if (s.sandboxEnabled && process.env.NODE_ENV !== 'production') providers.push('sandbox');
  return {
    enabled: s.enabled,
    currencySymbol: s.currencySymbol || DEFAULT_CURRENCY,
    currency: s.currency || DEFAULT_CURRENCY_CODE,
    providers,
    // 公钥不是秘密，但生产配置处于 test/未知模式时也不应向客户端宣告可用 Stripe 配置。
    stripePublishableKey: isStripeKeyAllowedForEnvironment(s.stripeSecretKey)
      ? s.stripePublishableKey
      : '',
  };
}
