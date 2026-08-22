-- SEC-005/006/008: durable, per-login refresh-token families.
-- Only SHA-256 hashes of jti values are stored; raw JWTs never enter the database.
CREATE TABLE `AuthTokenFamily` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `currentJtiHash` CHAR(64) NOT NULL,
  `legacyJtiHash` CHAR(64) NULL,
  `generation` INTEGER NOT NULL DEFAULT 0,
  `sessionStartedAt` DATETIME(3) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `revokedAt` DATETIME(3) NULL,
  `revokedReason` VARCHAR(64) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `AuthTokenFamily_currentJtiHash_key` (`currentJtiHash`),
  UNIQUE INDEX `AuthTokenFamily_legacyJtiHash_key` (`legacyJtiHash`),
  INDEX `AuthTokenFamily_userId_revokedAt_idx` (`userId`, `revokedAt`),
  INDEX `AuthTokenFamily_expiresAt_idx` (`expiresAt`),
  CONSTRAINT `AuthTokenFamily_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
