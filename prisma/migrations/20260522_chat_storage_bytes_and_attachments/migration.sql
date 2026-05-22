-- Claude.ai 风格全局对话（/chat）的 schema 准备：
--   1. User 新增 storageBytesUsed / storageBytesLimit（BigInt）—— 与录音 hours 配额并行的
--      字节配额，用于 chat 附件（图片 / 文档 / 文本）累计统计。FREE 默认 100MB
--      （104857600 字节），PRO / ADMIN 通过 SiteSetting 配置覆盖。
--   2. Conversation.sessionId 改可空 —— 允许"无录音绑定"的纯 chat 对话存在。
--   3. 新建 ConversationSession 联接表 —— 支持一对多录音挂载（一个 conversation
--      可同时挂多个 recording，一个 recording 可被多个 conversation 引用）。
--   4. 新建 ChatAttachment 表 —— 记录 Cloudreve 上传的 chat 附件，bytes/userId 冗余存
--      储便于 admin 按用户清理 + 配额复核。lastAccessedAt 支持 LRU 清理策略。

-- AlterTable
ALTER TABLE `Conversation` MODIFY `sessionId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `storageBytesLimit` BIGINT NOT NULL DEFAULT 104857600,
    ADD COLUMN `storageBytesUsed` BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `ConversationSession` (
    `conversationId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `addedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ConversationSession_sessionId_idx`(`sessionId`),
    PRIMARY KEY (`conversationId`, `sessionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ChatAttachment` (
    `id` VARCHAR(191) NOT NULL,
    `conversationId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `mimeType` VARCHAR(191) NOT NULL,
    `bytes` BIGINT NOT NULL,
    `cloudrevePath` VARCHAR(191) NOT NULL,
    `extractedTextPath` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastAccessedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ChatAttachment_conversationId_idx`(`conversationId`),
    INDEX `ChatAttachment_userId_idx`(`userId`),
    INDEX `ChatAttachment_createdAt_idx`(`createdAt`),
    INDEX `ChatAttachment_userId_lastAccessedAt_idx`(`userId`, `lastAccessedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ConversationSession` ADD CONSTRAINT `ConversationSession_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ConversationSession` ADD CONSTRAINT `ConversationSession_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ChatAttachment` ADD CONSTRAINT `ChatAttachment_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
