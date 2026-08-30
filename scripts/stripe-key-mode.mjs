/**
 * Dependency-free Stripe API key mode detector shared by the application and
 * deployment preflight. Keeping the prefix table here prevents startup and
 * request-time gates from drifting apart.
 *
 * @param {string} secretKey
 * @returns {'live' | 'test' | null}
 */
export function detectStripeKeyMode(secretKey) {
  if (secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_')) {
    return 'live';
  }
  if (secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_')) {
    return 'test';
  }
  return null;
}
