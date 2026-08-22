/**
 * Roles that a customer-facing membership product may grant.
 *
 * ADMIN is an authorization capability, not a purchasable entitlement. Keep this
 * policy free of server-only imports so the admin form can render the same allow
 * list that every server-side boundary enforces.
 */
export const PURCHASABLE_MEMBERSHIP_ROLES = ['PRO', 'FREE'] as const;

export type PurchasableMembershipRole =
  (typeof PURCHASABLE_MEMBERSHIP_ROLES)[number];

export function isPurchasableMembershipRole(
  value: unknown
): value is PurchasableMembershipRole {
  return (
    typeof value === 'string' &&
    (PURCHASABLE_MEMBERSHIP_ROLES as readonly string[]).includes(value)
  );
}

export function isForbiddenAdminTier(tier: {
  kind?: unknown;
  grantRole?: unknown;
}): boolean {
  return tier.kind === 'membership' && tier.grantRole === 'ADMIN';
}

/**
 * Preserve the legacy ADMIN value as quarantine/audit evidence, but present the
 * draft as inactive so the admin UI cannot accidentally re-publish it.
 */
export function prepareTierForAdminEdit<
  T extends { kind?: unknown; grantRole?: unknown; active?: boolean },
>(tier: T): T {
  return isForbiddenAdminTier(tier) ? { ...tier, active: false } : tier;
}

/**
 * The only mutation the generic tier editor may issue for a legacy ADMIN product
 * is its quarantine transition. In particular, omit kind/grantRole so the API's
 * legacy isolation branch can distinguish this from an attempted ADMIN grant.
 */
export function buildAdminTierMutation<
  T extends { id?: string; kind?: unknown; grantRole?: unknown; active?: boolean },
>(draft: T): T | { id: string; active: false } {
  if (draft.id && isForbiddenAdminTier(draft)) {
    return { id: draft.id, active: false };
  }
  return draft;
}
