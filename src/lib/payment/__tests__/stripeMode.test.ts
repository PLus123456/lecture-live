import { describe, expect, it } from 'vitest';
import {
  getStripeKeyMode,
  isStripeEventModeAllowed,
  isStripeKeyAllowedForEnvironment,
} from '@/lib/payment/stripeMode';

describe('SEC-024 Stripe key mode 共享判定', () => {
  it.each([
    ['sk_live_secret', 'live'],
    ['rk_live_restricted', 'live'],
    ['sk_test_secret', 'test'],
    ['rk_test_restricted', 'test'],
  ] as const)('%s → %s', (key, mode) => {
    expect(getStripeKeyMode(key)).toBe(mode);
  });

  it.each(['', 'pk_live_public', 'proxy_secret', ' SK_live_secret', 'SK_LIVE_secret'])(
    '未知/畸形 key %j 不猜测模式',
    (key) => {
      expect(getStripeKeyMode(key)).toBeNull();
    }
  );

  it('生产只允许明确的 live sk/rk；非生产保留 test 与本地代理兼容性', () => {
    expect(isStripeKeyAllowedForEnvironment('sk_live_x', 'production')).toBe(true);
    expect(isStripeKeyAllowedForEnvironment('rk_live_x', 'production')).toBe(true);
    expect(isStripeKeyAllowedForEnvironment('sk_test_x', 'production')).toBe(false);
    expect(isStripeKeyAllowedForEnvironment('rk_test_x', 'production')).toBe(false);
    expect(isStripeKeyAllowedForEnvironment('proxy_x', 'production')).toBe(false);
    expect(isStripeKeyAllowedForEnvironment('sk_test_x', 'development')).toBe(true);
    expect(isStripeKeyAllowedForEnvironment('proxy_x', 'test')).toBe(true);
  });

  it('已知 key 的 webhook livemode 必须双向匹配，生产未知 key 永不放行', () => {
    expect(isStripeEventModeAllowed('sk_live_x', true, 'production')).toBe(true);
    expect(isStripeEventModeAllowed('rk_live_x', false, 'production')).toBe(false);
    expect(isStripeEventModeAllowed('sk_test_x', false, 'test')).toBe(true);
    expect(isStripeEventModeAllowed('rk_test_x', true, 'development')).toBe(false);
    expect(isStripeEventModeAllowed('proxy_x', true, 'production')).toBe(false);
    expect(isStripeEventModeAllowed('proxy_x', false, 'test')).toBe(true);
  });
});
