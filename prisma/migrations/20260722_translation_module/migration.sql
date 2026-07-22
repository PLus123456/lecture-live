-- 翻译系统模块：LlmPurpose 加 TRANSLATION + 翻译 worker/任务两张新表
-- 注意：本项目用 prisma db push 同步 schema，此文件仅作演进记录（不被 migrate 消费）。

-- 1) LLM 用途枚举加 TRANSLATION（MySQL ENUM 需全量重列）
ALTER TABLE `LlmModel` MODIFY COLUMN `purpose` ENUM(
  'CHAT',
  'REALTIME_SUMMARY',
  'FINAL_SUMMARY',
  'KEYWORD_EXTRACTION',
  'EMBEDDING',
  'TRANSLATION'
) NOT NULL DEFAULT 'CHAT';

-- 2) 文档翻译外部 worker（一机一行一套设置；token 应用层 AES-256-GCM 加密）
CREATE TABLE `TranslationWorker` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `baseUrl` VARCHAR(191) NOT NULL,
  `token` TEXT NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `concurrency` INTEGER NOT NULL DEFAULT 1,
  `weight` INTEGER NOT NULL DEFAULT 1,
  `qps` INTEGER NOT NULL DEFAULT 4,
  `status` VARCHAR(191) NOT NULL DEFAULT 'UNVERIFIED',
  `lastCheckedAt` DATETIME(3) NULL,
  `lastError` TEXT NULL,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3) 文档翻译任务（业务真源；调度态在 JobQueue type=doc_translate）
CREATE TABLE `TranslationTask` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `fileName` VARCHAR(191) NOT NULL,
  `fileBytes` INTEGER NOT NULL,
  `pageCount` INTEGER NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'QUOTED',
  `progress` INTEGER NOT NULL DEFAULT 0,
  `sourceLang` VARCHAR(191) NOT NULL,
  `targetLang` VARCHAR(191) NOT NULL,
  `modelId` VARCHAR(191) NULL,
  `glossaryJson` TEXT NULL,
  `estimatedCents` INTEGER NOT NULL DEFAULT 0,
  `chargedCents` INTEGER NOT NULL DEFAULT 0,
  `refundedAt` DATETIME(3) NULL,
  `sourcePath` VARCHAR(191) NULL,
  `monoPath` VARCHAR(191) NULL,
  `dualPath` VARCHAR(191) NULL,
  `llmInputTokens` INTEGER NOT NULL DEFAULT 0,
  `llmOutputTokens` INTEGER NOT NULL DEFAULT 0,
  `proxyTokenHash` VARCHAR(191) NULL,
  `workerId` VARCHAR(191) NULL,
  `jobQueueId` VARCHAR(191) NULL,
  `errorMessage` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `completedAt` DATETIME(3) NULL,
  UNIQUE INDEX `TranslationTask_proxyTokenHash_key`(`proxyTokenHash`),
  INDEX `TranslationTask_userId_createdAt_idx`(`userId`, `createdAt`),
  INDEX `TranslationTask_status_createdAt_idx`(`status`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `TranslationTask_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
