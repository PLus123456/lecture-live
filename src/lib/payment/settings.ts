import 'server-only';

import { prisma } from '@/lib/prisma';
import { encrypt, decrypt } from '@/lib/crypto';
import { SETTING_SECRET_MASK } from '@/lib/siteSettings';
import type { PaymentProviderName } from '@/lib/payment/types';

/**
 * 充值系统配置（货币 + 各支付渠道开关与凭据）。存于 SiteSetting 的 `recharge_*` 键。
 * 敏感凭据（私钥/密钥）加密落库；admin GET 只回脱敏占位。与站点其它设置隔离，
 * 不污染 `siteSettings.ts` 的 SiteSettings 大接口——充值配置项多且专用。
 */
export interface RechargeSettings {
  enabled: boolean; // 充值系统总开关
  currencySymbol: string; // 货币符号，默认 ¥
  // 各渠道启用开关
  alipayEnabled: boolean;
  wechatEnabled: boolean;
  stripeEnabled: boolean;
  sandboxEnabled: boolean; // 开发/测试沙箱渠道（生产应关）
  // 支付宝（电脑网站支付）
  alipayAppId: string;
  alipayPrivateKey: string; // 敏感：应用私钥（PKCS8）
  alipayPublicKey: string; // 支付宝公钥（验签用，非敏感）
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

/** 敏感字段（加密落库 + 脱敏回传）。 */
const SECRET_FIELDS = [
  'alipayPrivateKey',
  'wechatApiV3Key',
  'wechatPrivateKey',
  'stripeSecretKey',
  'stripeWebhookSecret',
] as const;

type FieldKind = 'string' | 'bool' | 'secret';
const FIELD_MAP: Array<{ field: keyof RechargeSettings; key: string; kind: FieldKind }> = [
  { field: 'enabled', key: 'recharge_enabled', kind: 'bool' },
  { field: 'currencySymbol', key: 'recharge_currency_symbol', kind: 'string' },
  { field: 'alipayEnabled', key: 'recharge_alipay_enabled', kind: 'bool' },
  { field: 'wechatEnabled', key: 'recharge_wechat_enabled', kind: 'bool' },
  { field: 'stripeEnabled', key: 'recharge_stripe_enabled', kind: 'bool' },
  { field: 'sandboxEnabled', key: 'recharge_sandbox_enabled', kind: 'bool' },
  { field: 'alipayAppId', key: 'recharge_alipay_app_id', kind: 'string' },
  { field: 'alipayPrivateKey', key: 'recharge_alipay_private_key', kind: 'secret' },
  { field: 'alipayPublicKey', key: 'recharge_alipay_public_key', kind: 'string' },
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
    alipayEnabled: bool('recharge_alipay_enabled', false),
    wechatEnabled: bool('recharge_wechat_enabled', false),
    stripeEnabled: bool('recharge_stripe_enabled', false),
    sandboxEnabled: bool('recharge_sandbox_enabled', false),
    alipayAppId: str('recharge_alipay_app_id', ''),
    alipayPrivateKey: decryptSafe(raw['recharge_alipay_private_key']),
    alipayPublicKey: str('recharge_alipay_public_key', ''),
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

/** 写入充值配置（部分更新）。敏感字段收到掩码/空串 = 保持原值（不清密钥）。 */
export async function updateRechargeSettings(
  patch: Partial<RechargeSettings>
): Promise<void> {
  const writes: Array<Promise<unknown>> = [];
  for (const { field, key, kind } of FIELD_MAP) {
    const v = patch[field];
    if (v === undefined) continue;
    let value: string;
    if (kind === 'bool') {
      value = v ? 'true' : 'false';
    } else if (kind === 'secret') {
      // 掩码或空 = 保持原值不变（避免脱敏值被回存导致密钥被清空）
      if (v === SETTING_SECRET_MASK || v === '') continue;
      value = encrypt(String(v));
    } else {
      value = String(v);
    }
    writes.push(
      prisma.siteSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      })
    );
  }
  await Promise.all(writes);
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

/** 面向普通用户的公开配置（无任何凭据）：货币符号 + 已启用且已配置的渠道列表。 */
export function toPublicRechargeConfig(s: RechargeSettings): {
  enabled: boolean;
  currencySymbol: string;
  providers: PaymentProviderName[];
  stripePublishableKey: string;
} {
  const providers: PaymentProviderName[] = [];
  if (s.alipayEnabled && s.alipayAppId && s.alipayPrivateKey) providers.push('alipay');
  if (s.wechatEnabled && s.wechatMchId && s.wechatApiV3Key) providers.push('wechat');
  if (s.stripeEnabled && s.stripeSecretKey) providers.push('stripe');
  if (s.sandboxEnabled) providers.push('sandbox');
  return {
    enabled: s.enabled,
    currencySymbol: s.currencySymbol || DEFAULT_CURRENCY,
    providers,
    stripePublishableKey: s.stripePublishableKey,
  };
}
