import 'server-only';

import type { PaymentProvider, PaymentProviderName } from '@/lib/payment/types';
import { getRechargeSettings, type RechargeSettings } from '@/lib/payment/settings';
import { SandboxProvider } from '@/lib/payment/providers/sandbox';
import { StripeProvider } from '@/lib/payment/providers/stripe';
import { AlipayProvider } from '@/lib/payment/providers/alipay';
import { WechatProvider } from '@/lib/payment/providers/wechat';

/**
 * 按渠道名装配一个支付 provider。仅当该渠道已在 admin 启用且凭据齐全才返回实例，否则 null
 *（checkout 路由据此回 400「渠道不可用」）。凭据在各 provider 构造时校验。
 */
export async function getPaymentProvider(
  name: PaymentProviderName,
  settings?: RechargeSettings
): Promise<PaymentProvider | null> {
  const s = settings ?? (await getRechargeSettings());
  if (!s.enabled) return null;

  switch (name) {
    case 'sandbox':
      return s.sandboxEnabled ? new SandboxProvider() : null;
    case 'stripe':
      return s.stripeEnabled && s.stripeSecretKey ? new StripeProvider(s) : null;
    case 'alipay':
      return s.alipayEnabled && s.alipayAppId && s.alipayPrivateKey
        ? new AlipayProvider(s)
        : null;
    case 'wechat':
      return s.wechatEnabled && s.wechatMchId && s.wechatApiV3Key
        ? new WechatProvider(s)
        : null;
    default:
      return null;
  }
}
