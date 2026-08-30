import { detectStripeKeyMode } from '../../../scripts/stripe-key-mode.mjs';

/** Stripe API secret/restricted key 所属的账户模式。 */
export type StripeKeyMode = 'live' | 'test';

/**
 * Stripe 的标准 secret key 与 restricted key 都把模式编码在前缀中。
 * 未知前缀在非生产环境保留给本地代理/测试替身；生产环境必须 fail-closed。
 */
export function getStripeKeyMode(secretKey: string): StripeKeyMode | null {
  return detectStripeKeyMode(secretKey);
}

/** 生产环境只允许明确可识别的 live key。 */
export function isStripeKeyAllowedForEnvironment(
  secretKey: string,
  nodeEnv = process.env.NODE_ENV
): boolean {
  return nodeEnv !== 'production' || getStripeKeyMode(secretKey) === 'live';
}

/**
 * Webhook 的 `livemode` 是签名体的一部分，必须与 API key 模式严格同侧。
 * 生产环境还要求 key 本身可明确识别为 live；未知 key 不得靠伪造前缀外的兼容路径放行。
 */
export function isStripeEventModeAllowed(
  secretKey: string,
  livemode: unknown,
  nodeEnv = process.env.NODE_ENV
): boolean {
  const keyMode = getStripeKeyMode(secretKey);
  if (nodeEnv === 'production' && keyMode !== 'live') return false;
  if (keyMode === 'live') return livemode === true;
  if (keyMode === 'test') return livemode === false;
  return nodeEnv !== 'production';
}
