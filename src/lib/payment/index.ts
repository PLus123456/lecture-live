import 'server-only';

import type { PaymentProvider, PaymentProviderName } from '@/lib/payment/types';
import {
  getRechargeSettings,
  hasChannelCredentials,
  type RechargeSettings,
} from '@/lib/payment/settings';
import { SandboxProvider } from '@/lib/payment/providers/sandbox';
import { StripeProvider } from '@/lib/payment/providers/stripe';
import { AlipayProvider } from '@/lib/payment/providers/alipay';
import { WechatProvider } from '@/lib/payment/providers/wechat';

/** 按渠道名实例化（不做任何可用性判定，判定在两个入口各自的门禁里）。 */
function instantiate(name: PaymentProviderName, s: RechargeSettings): PaymentProvider | null {
  switch (name) {
    case 'sandbox':
      return new SandboxProvider();
    case 'stripe':
      return new StripeProvider(s);
    case 'alipay':
      return new AlipayProvider(s);
    case 'wechat':
      return new WechatProvider(s);
    default:
      return null;
  }
}

/**
 * 【下单方向】按渠道名装配一个支付 provider。仅当总开关开、该渠道已在 admin 启用、
 * 且**收款与验签凭据都齐**才返回实例，否则 null（checkout 路由据此回 400「渠道不可用」）。
 * 验签凭据一并算进就绪度（P3-5）：只看收款凭据会放行「能付款但回调必被拒」的半配置渠道。
 * Stripe 就绪度还包含 SEC-024 的环境门禁：生产环境只装配明确的 live key。
 */
export async function getPaymentProvider(
  name: PaymentProviderName,
  settings?: RechargeSettings
): Promise<PaymentProvider | null> {
  const s = settings ?? (await getRechargeSettings());
  if (!s.enabled) return null;

  // 沙箱无验签、无真实支付：即便管理员误开 DB 开关，也在生产环境硬拒（H4）。
  // 非生产（dev/test/e2e）才据开关启用，让本地/测试链路可完整跑通。
  if (name === 'sandbox') {
    return s.sandboxEnabled && process.env.NODE_ENV !== 'production'
      ? new SandboxProvider()
      : null;
  }

  const enabled =
    (name === 'stripe' && s.stripeEnabled) ||
    (name === 'alipay' && s.alipayEnabled) ||
    (name === 'wechat' && s.wechatEnabled);
  if (!enabled || !hasChannelCredentials(s, name)) return null;
  return instantiate(name, s);
}

/**
 * 【回调方向】按**凭据是否齐全**装配 provider，**刻意忽略 enabled 开关与总开关**（P3-11）。
 * 在途订单的回调不该因为管理员在用户付款后停用了渠道就被打成 400：网关会重试到耗尽然后放弃，
 * 钱收了、订单永久 pending。验签仍是唯一信任源，验不过照样拒——所以忽略开关不放大攻击面。
 * 沙箱仍受 NODE_ENV 硬拒（生产绝不接受无验签渠道的到账）。
 * Stripe 虽忽略开关，但仍复用同一环境门禁，生产 test/未知 key 不能装配 callback provider。
 */
export async function getCallbackPaymentProvider(
  name: PaymentProviderName,
  settings?: RechargeSettings
): Promise<PaymentProvider | null> {
  const s = settings ?? (await getRechargeSettings());
  if (name === 'sandbox') {
    // 沙箱是唯一没有验签的渠道 → 开关就是它**仅有**的门禁，这里不能一起忽略。
    return s.sandboxEnabled && process.env.NODE_ENV !== 'production'
      ? new SandboxProvider()
      : null;
  }
  if (!hasChannelCredentials(s, name)) return null;
  return instantiate(name, s);
}
