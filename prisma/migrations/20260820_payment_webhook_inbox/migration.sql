-- SEC-026: verified payment callbacks must enter a durable inbox before ACK, and
-- provider objects must be namespaced by provider + mode + account + object type.
ALTER TABLE `PaymentOrder`
  ADD COLUMN `providerMode` VARCHAR(191) NOT NULL DEFAULT 'unknown',
  ADD COLUMN `providerAccount` VARCHAR(191) NOT NULL DEFAULT 'default',
  ADD COLUMN `providerCheckoutSessionRef` VARCHAR(191) NULL,
  ADD COLUMN `providerPaymentIntentRef` VARCHAR(191) NULL,
  ADD COLUMN `providerChargeRef` VARCHAR(191) NULL;

-- providerRef historically held the Checkout Session id for Stripe. Preserve that
-- evidence in the typed column, but do not guess live/test/account for object mapping.
UPDATE `PaymentOrder`
SET `providerCheckoutSessionRef` = `providerRef`
WHERE `provider` = 'stripe'
  AND `providerRef` LIKE 'cs\\_%'
  AND `providerCheckoutSessionRef` IS NULL;

CREATE INDEX `payment_order_provider_ref_idx`
  ON `PaymentOrder`(`provider`, `providerMode`, `providerAccount`, `providerRef`);
CREATE INDEX `payment_order_pi_ref_idx`
  ON `PaymentOrder`(`provider`, `providerMode`, `providerAccount`, `providerPaymentIntentRef`);
CREATE INDEX `payment_order_charge_ref_idx`
  ON `PaymentOrder`(`provider`, `providerMode`, `providerAccount`, `providerChargeRef`);

CREATE TABLE `PaymentWebhookEvent` (
  `id` VARCHAR(191) NOT NULL,
  `provider` VARCHAR(32) NOT NULL,
  `providerMode` VARCHAR(16) NOT NULL,
  `providerAccount` VARCHAR(191) NOT NULL,
  `eventId` VARCHAR(191) NOT NULL,
  `eventType` VARCHAR(191) NOT NULL,
  `objectType` VARCHAR(64) NULL,
  `objectId` VARCHAR(191) NULL,
  `outTradeNo` VARCHAR(191) NULL,
  `payloadJson` TEXT NOT NULL,
  `payloadSha256` CHAR(64) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'received',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `lastError` TEXT NULL,
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `processedAt` DATETIME(3) NULL,
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `payment_webhook_event_identity_key`
    (`provider`, `providerMode`, `providerAccount`, `eventId`),
  INDEX `payment_webhook_status_received_idx` (`status`, `receivedAt`),
  INDEX `payment_webhook_object_idx`
    (`provider`, `providerMode`, `providerAccount`, `objectType`, `objectId`),
  INDEX `payment_webhook_out_trade_no_idx` (`outTradeNo`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PaymentProviderObject` (
  `id` VARCHAR(191) NOT NULL,
  `provider` VARCHAR(32) NOT NULL,
  `providerMode` VARCHAR(16) NOT NULL,
  `providerAccount` VARCHAR(191) NOT NULL,
  `objectType` VARCHAR(64) NOT NULL,
  `objectId` VARCHAR(191) NOT NULL,
  `orderId` VARCHAR(191) NOT NULL,
  `firstEventId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastSeenAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `payment_provider_object_identity_key`
    (`provider`, `providerMode`, `providerAccount`, `objectType`, `objectId`),
  INDEX `payment_provider_object_order_idx` (`orderId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PaymentReviewCase` (
  `id` VARCHAR(191) NOT NULL,
  `dedupeKey` CHAR(64) NOT NULL,
  `userId` VARCHAR(191) NULL,
  `orderId` VARCHAR(191) NULL,
  `webhookEventId` VARCHAR(191) NULL,
  `reason` VARCHAR(191) NOT NULL,
  `detailJson` TEXT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'open',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `resolvedAt` DATETIME(3) NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `PaymentReviewCase_dedupeKey_key` (`dedupeKey`),
  INDEX `payment_review_status_created_idx` (`status`, `createdAt`),
  INDEX `payment_review_order_idx` (`orderId`),
  INDEX `payment_review_webhook_idx` (`webhookEventId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
