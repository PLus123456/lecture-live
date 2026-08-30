import { describe, expect, it } from 'vitest';
import {
  buildAdminTierMutation,
  isPurchasableMembershipRole,
  prepareTierForAdminEdit,
} from '@/lib/payment/tierPolicy';

describe('SEC-023 tier policy', () => {
  it('customer membership allowlist excludes ADMIN', () => {
    expect(isPurchasableMembershipRole('PRO')).toBe(true);
    expect(isPurchasableMembershipRole('FREE')).toBe(true);
    expect(isPurchasableMembershipRole('ADMIN')).toBe(false);
  });

  it('legacy ADMIN edit preserves evidence and only prepares deactivation', () => {
    const legacy = {
      id: 'legacy-admin',
      kind: 'membership',
      grantRole: 'ADMIN',
      active: true,
      name: 'historical row',
    };

    const draft = prepareTierForAdminEdit(legacy);

    expect(draft).toMatchObject({ grantRole: 'ADMIN', active: false });
    expect(legacy).toMatchObject({ grantRole: 'ADMIN', active: true });
    expect(buildAdminTierMutation(draft)).toEqual({
      id: 'legacy-admin',
      active: false,
    });
  });

  it('ordinary tier edits retain their full payload', () => {
    const draft = {
      id: 'pro',
      kind: 'membership',
      grantRole: 'PRO',
      active: true,
      name: 'PRO',
    };
    expect(buildAdminTierMutation(draft)).toBe(draft);
  });
});
