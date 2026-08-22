-- SEC-030: immutable, per-charge transcription accounting ledger.
--
-- Production deployment uses `prisma db push`; this file records the intended evolution for
-- migrate-based installations. `scripts/db-migrate-data.mjs --security-only` performs the
-- idempotent legacy opening-balance cutover after db push creates this table.
CREATE TABLE `TranscriptionCharge` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `source` VARCHAR(64) NOT NULL,
  `referenceId` VARCHAR(191) NULL,
  `minutes` INTEGER NOT NULL,
  `chargedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `legacyAmbiguous` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `TranscriptionCharge_userId_chargedAt_idx`(`userId`, `chargedAt`),
  INDEX `TranscriptionCharge_referenceId_idx`(`referenceId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
