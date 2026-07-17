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
      // 沙箱无验签、无真实支付：即便管理员误开 DB 开关，也在生产环境硬拒（H4）。
      // 非生产（dev/test/e2e）才据开关启用，让本地/测试链路可完整跑通。
      return s.sandboxEnabled && process.env.NODE_ENV !== 'production'
        ? new SandboxProvider()
        : null;
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
