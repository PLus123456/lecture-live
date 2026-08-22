-- SEC-025: durable funding lots, spend allocations, entitlement provenance and
-- non-negative debt/hold handling for refunds and chargebacks.
CREATE TABLE `WalletFundingLot` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `sourceOrderId` VARCHAR(191) NULL,
  `sourceTransactionId` VARCHAR(191) NULL,
  `sourceKind` VARCHAR(32) NOT NULL,
  `originalCents` INTEGER UNSIGNED NOT NULL,
  `remainingCents` INTEGER UNSIGNED NOT NULL,
  `reversedCents` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `reversedAt` DATETIME(3) NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `WalletFundingLot_sourceOrderId_key` (`sourceOrderId`),
  UNIQUE INDEX `WalletFundingLot_sourceTransactionId_key` (`sourceTransactionId`),
  INDEX `wallet_funding_lot_user_status_idx` (`userId`, `status`, `createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WalletFundingAllocation` (
  `id` VARCHAR(191) NOT NULL,
  `fundingLotId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `spendTransactionId` VARCHAR(191) NOT NULL,
  `entitlementId` VARCHAR(191) NULL,
  `targetKind` VARCHAR(32) NOT NULL,
  `amountCents` INTEGER UNSIGNED NOT NULL,
  `entitlementUnits` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  `recoveredUnits` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  `debtCents` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  `reversedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE INDEX `wallet_funding_allocation_identity_key` (`fundingLotId`, `spendTransactionId`),
  INDEX `wallet_funding_allocation_spend_idx` (`spendTransactionId`),
  INDEX `wallet_funding_allocation_entitlement_idx` (`entitlementId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PaymentDebt` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `sourceOrderId` VARCHAR(191) NOT NULL,
  `sourceLotId` VARCHAR(191) NULL,
  `amountCents` INTEGER UNSIGNED NOT NULL,
  `recoveredCents` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  `reason` VARCHAR(191) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'open',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `resolvedAt` DATETIME(3) NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `payment_debt_source_reason_key` (`sourceOrderId`, `reason`),
  INDEX `payment_debt_user_status_idx` (`userId`, `status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PaymentAccountHold` (
  `id` VARCHAR(191) NOT NULL,
  `dedupeKey` CHAR(64) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `sourceOrderId` VARCHAR(191) NULL,
  `debtId` VARCHAR(191) NULL,
  `reason` VARCHAR(191) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `releasedAt` DATETIME(3) NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `PaymentAccountHold_dedupeKey_key` (`dedupeKey`),
  INDEX `payment_account_hold_user_status_idx` (`userId`, `status`),
  INDEX `payment_account_hold_order_idx` (`sourceOrderId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Deliberately no historical lot backfill: old aggregate balances cannot be safely attributed
-- to individual topups after spending. A reversal of such an order is quarantined for review.

-- The fulfillment migration marked every historical refunded row as unresolved. Freeze those
-- accounts until an administrator completes manual provenance review; no debt amount is guessed.
INSERT INTO `PaymentAccountHold` (
  `id`, `dedupeKey`, `userId`, `sourceOrderId`, `debtId`, `reason`,
  `status`, `createdAt`, `updatedAt`
)
SELECT UUID(), SHA2(CONCAT('legacy_refund_unresolved:', `po`.`id`), 256),
       `po`.`userId`, `po`.`id`, NULL, 'legacy_refund_unresolved',
       'active', NOW(3), NOW(3)
FROM `PaymentOrder` `po`
WHERE `po`.`fulfillmentStatus` = 'review'
  AND `po`.`reviewReason` = 'legacy_refund_unresolved'
ON DUPLICATE KEY UPDATE
  `status` = 'active', `releasedAt` = NULL, `updatedAt` = NOW(3);
