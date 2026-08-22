-- SEC-023: ADMIN is an operational authorization role, never a purchasable entitlement.
--
-- Preserve legacy rows for incident review, but quarantine any that are currently visible
-- before installing the constraint. PaymentOrder metadata snapshots are intentionally not
-- rewritten; the wallet's final grant gate rejects their ADMIN grantRole fail-closed.
UPDATE `RechargeTier`
SET `active` = FALSE
WHERE `kind` = 'membership'
  AND `grantRole` = 'ADMIN'
  AND `active` = TRUE;

ALTER TABLE `RechargeTier`
  ADD CONSTRAINT `RechargeTier_no_active_admin_grant_chk`
  CHECK (
    NOT (
      `kind` = 'membership'
      AND `grantRole` = 'ADMIN'
      AND `active` = TRUE
    )
  );
