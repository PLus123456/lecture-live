-- SEC-013/016/019: one durable source of truth for every persisted artifact.
-- This migration is intentionally named `zz_*` so it runs after the other
-- independently developed 2026-08-20 migrations in lexical deploy order.

ALTER TABLE `ChatAttachment`
  ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'UPLOAD',
  ADD COLUMN `storedArtifactId` VARCHAR(191) NULL,
  ADD COLUMN `expiresAt` DATETIME(3) NULL,
  ADD UNIQUE INDEX `ChatAttachment_storedArtifactId_key` (`storedArtifactId`),
  ADD INDEX `ChatAttachment_conversationId_source_idx` (`conversationId`, `source`),
  ADD INDEX `ChatAttachment_source_expiresAt_idx` (`source`, `expiresAt`);

CREATE TABLE `StoredArtifact` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `ownerType` VARCHAR(32) NOT NULL,
  `ownerId` VARCHAR(191) NOT NULL,
  `sessionId` VARCHAR(191) NULL,
  `conversationId` VARCHAR(191) NULL,
  `artifactType` VARCHAR(48) NOT NULL,
  `storage` VARCHAR(16) NOT NULL,
  `reference` VARCHAR(768) NULL,
  `state` VARCHAR(16) NOT NULL DEFAULT 'RESERVED',
  `bytes` BIGINT NOT NULL DEFAULT 0,
  `chargedBytes` BIGINT NOT NULL DEFAULT 0,
  `identityKey` VARCHAR(191) NULL,
  `logicalKey` VARCHAR(191) NOT NULL,
  `reservationKey` VARCHAR(191) NOT NULL,
  `replacesArtifactId` VARCHAR(191) NULL,
  `expiresAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `deletedAt` DATETIME(3) NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `StoredArtifact_identityKey_key` (`identityKey`),
  UNIQUE INDEX `StoredArtifact_reservationKey_key` (`reservationKey`),
  INDEX `StoredArtifact_userId_state_idx` (`userId`, `state`),
  INDEX `StoredArtifact_ownerType_ownerId_state_idx` (`ownerType`, `ownerId`, `state`),
  INDEX `StoredArtifact_sessionId_state_artifactType_idx` (`sessionId`, `state`, `artifactType`),
  INDEX `StoredArtifact_conversationId_state_artifactType_idx` (`conversationId`, `state`, `artifactType`),
  INDEX `StoredArtifact_logicalKey_state_idx` (`logicalKey`, `state`),
  INDEX `StoredArtifact_state_expiresAt_idx` (`state`, `expiresAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Backfill of actual bytes is deliberately performed by
-- scripts/backfill-stored-artifacts.mjs after db push.  Until it writes the
-- completion marker, runtime reconciliation refuses to overwrite the legacy
-- User.storageBytesUsed counter.
