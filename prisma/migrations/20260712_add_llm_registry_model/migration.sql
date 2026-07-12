-- LLM 设置重构：模型库 / 用途路由拆分。
-- LlmRegistryModel = 模型库（规格真源：modelId/displayName/kind/supportsImage/maxTokens/contextWindow/维度/验证状态）；
-- LlmModel 语义收窄为「用途路由行」（purpose × 模型，参数 thinkingMode/thinkingDepth/temperature/isDefault 按用途独立），
-- 其规格列保留为 registry 的写穿副本（gateway/客户端运行时读取处零变化，旧 id 引用全部保持有效）。
-- 历史行的 registry 条目由 ensureLlmRegistry() 在 admin 面板首次加载时幂等补建并回填 registryId。

-- CreateTable
CREATE TABLE `LlmRegistryModel` (
    `id` VARCHAR(191) NOT NULL,
    `providerId` VARCHAR(191) NOT NULL,
    `modelId` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL DEFAULT 'TEXT',
    `supportsImage` BOOLEAN NOT NULL DEFAULT false,
    `maxTokens` INTEGER NOT NULL DEFAULT 4096,
    `contextWindow` INTEGER NOT NULL DEFAULT 8192,
    `embeddingDimensions` INTEGER NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'UNVERIFIED',
    `lastCheckedAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LlmRegistryModel_providerId_idx`(`providerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `LlmModel` ADD COLUMN `registryId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `LlmModel_registryId_idx` ON `LlmModel`(`registryId`);

-- AddForeignKey
ALTER TABLE `LlmRegistryModel` ADD CONSTRAINT `LlmRegistryModel_providerId_fkey` FOREIGN KEY (`providerId`) REFERENCES `LlmProvider`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LlmModel` ADD CONSTRAINT `LlmModel_registryId_fkey` FOREIGN KEY (`registryId`) REFERENCES `LlmRegistryModel`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
