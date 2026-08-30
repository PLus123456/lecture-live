-- SEC-027/028: make fulfillment a first-class order state and persist composable
-- membership/minute entitlement sources. Historical purchase grants are not guessed.
ALTER TABLE `PaymentOrder`
  ADD COLUMN `fulfillmentStatus` VARCHAR(32) NOT NULL DEFAULT 'pending',
  ADD COLUMN `fulfillmentStartedAt` DATETIME(3) NULL,
  ADD COLUMN `fulfilledAt` DATETIME(3) NULL,
  ADD COLUMN `fulfillmentError` TEXT NULL;

-- Historical topups are unambiguous. Historical purchases count as fulfilled only when their
-- existing wallet ledger proves the grant ran; missing proof is quarantined for manual review.
UPDATE `PaymentOrder` po
SET po.`fulfillmentStatus` = CASE
      -- Legacy reversal only touched aggregate state and cannot prove downstream entitlements were
      -- recovered. Quarantine every historical refunded row; new code writes `reversed` itself.
      WHEN po.`status` = 'refunded' OR po.`refundedAt` IS NOT NULL THEN 'review'
      WHEN po.`status` = 'paid' AND po.`kind` = 'topup' THEN 'fulfilled'
      WHEN po.`status` = 'paid' AND po.`kind` = 'purchase' AND EXISTS (
        SELECT 1 FROM `WalletTransaction` wt
        WHERE wt.`orderId` = po.`id`
          AND wt.`type` IN ('purchase_membership', 'purchase_minutes')
      ) THEN 'fulfilled'
      WHEN po.`status` = 'paid' AND po.`kind` = 'purchase' THEN 'review'
      ELSE 'pending'
    END,
    po.`fulfilledAt` = CASE
      WHEN po.`status` = 'paid' AND (
        po.`kind` = 'topup' OR EXISTS (
          SELECT 1 FROM `WalletTransaction` wt
          WHERE wt.`orderId` = po.`id`
            AND wt.`type` IN ('purchase_membership', 'purchase_minutes')
        )
      ) THEN po.`paidAt`
      ELSE NULL
    END,
    po.`reviewReason` = CASE
      WHEN po.`status` = 'refunded' OR po.`refundedAt` IS NOT NULL
        THEN 'legacy_refund_unresolved'
      WHEN po.`status` = 'paid' AND po.`kind` = 'purchase' AND NOT EXISTS (
        SELECT 1 FROM `WalletTransaction` wt
        WHERE wt.`orderId` = po.`id`
          AND wt.`type` IN ('purchase_membership', 'purchase_minutes')
      ) THEN 'legacy_fulfillment_unresolved'
      ELSE po.`reviewReason`
    END,
    po.`fulfillmentError` = CASE
      WHEN po.`status` = 'refunded' OR po.`refundedAt` IS NOT NULL
        THEN 'historical refund has no complete downstream reversal proof'
      WHEN po.`status` = 'paid' AND po.`kind` = 'purchase' AND NOT EXISTS (
        SELECT 1 FROM `WalletTransaction` wt
        WHERE wt.`orderId` = po.`id`
          AND wt.`type` IN ('purchase_membership', 'purchase_minutes')
      ) THEN 'historical paid order has no grant ledger proof'
      ELSE po.`fulfillmentError`
    END;

CREATE INDEX `payment_order_fulfillment_idx`
  ON `PaymentOrder`(`fulfillmentStatus`, `createdAt`);

CREATE TABLE `PaymentEntitlement` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `sourceOrderId` VARCHAR(191) NULL,
  `walletTransactionId` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `grantRole` VARCHAR(32) NULL,
  `totalUnits` INTEGER UNSIGNED NOT NULL,
  `revokedUnits` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  `priceCents` INTEGER UNSIGNED NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active',
  `grantedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `reversedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `PaymentEntitlement_walletTransactionId_key` (`walletTransactionId`),
  INDEX `payment_entitlement_order_idx` (`sourceOrderId`),
  INDEX `payment_entitlement_user_status_idx` (`userId`, `status`, `grantedAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
