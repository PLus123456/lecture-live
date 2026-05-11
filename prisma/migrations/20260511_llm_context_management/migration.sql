-- LLM 上下文管理：
--   1. LlmModel 加 contextWindow 字段（模型输入上下文窗口），从现有 maxTokens 复制
--   2. LlmPurpose 枚举加 EMBEDDING 值（用于 chat L6 RAG 检索）
--   3. 新建 Conversation / ConversationMessage 模型（chat 历史持久化）
--
-- 注：LlmModel.maxTokens 含义保持不变（单次输出 max_tokens）。原先填入的
-- 大数值（如 256000）经 LLM API 会被自动 clamp，行为不会立刻坏；建议升级后
-- 到 admin 面板把 maxTokens 重置为合理输出值（4096-8192）。

-- ─── LlmModel.contextWindow ───
ALTER TABLE `LlmModel`
  ADD COLUMN `contextWindow` INT NOT NULL DEFAULT 8192;

-- 把现有 maxTokens 值复制到 contextWindow（用户当前在 admin 面板填的就是
-- 模型上下文窗口语义，行为虽因 API clamp 仍工作但语义错位 —— 这次迁移把
-- 它放到正确字段）。
UPDATE `LlmModel` SET `contextWindow` = `maxTokens`;

-- ─── Conversation ───
CREATE TABLE `Conversation` (
  `id` VARCHAR(191) NOT NULL,
  `sessionId` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NULL,
  `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `endedAt` DATETIME(3) NULL,
  `degradationLevel` INT NOT NULL DEFAULT 1,

  PRIMARY KEY (`id`),
  INDEX `Conversation_sessionId_startedAt_idx` (`sessionId`, `startedAt`),
  CONSTRAINT `Conversation_sessionId_fkey`
    FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── ConversationMessage ───
CREATE TABLE `ConversationMessage` (
  `id` VARCHAR(191) NOT NULL,
  `conversationId` VARCHAR(191) NOT NULL,
  `role` VARCHAR(191) NOT NULL,
  `content` TEXT NOT NULL,
  `transcriptOffsetMs` INT NULL,
  `degradationLevel` INT NULL,
  `inputTokens` INT NULL,
  `outputTokens` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `ConversationMessage_conversationId_createdAt_idx` (`conversationId`, `createdAt`),
  CONSTRAINT `ConversationMessage_conversationId_fkey`
    FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── LlmPurpose 枚举值 EMBEDDING ───
-- MySQL: Prisma 把 enum 实现为 ENUM 列类型，需要 ALTER TABLE 改列定义把新值塞进去
ALTER TABLE `LlmModel`
  MODIFY COLUMN `purpose` ENUM('CHAT', 'REALTIME_SUMMARY', 'FINAL_SUMMARY', 'KEYWORD_EXTRACTION', 'EMBEDDING') NOT NULL DEFAULT 'CHAT';
