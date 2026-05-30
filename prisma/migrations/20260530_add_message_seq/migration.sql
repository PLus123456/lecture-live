-- 给 ConversationMessage 加全局单调自增 seq 列（稳定排序键）：
--   背景：压缩切割点（findCompressionBoundary）此前依赖 createdAt 排序的物理位置定位
--   system 切割消息；同毫秒时间戳下 user/assistant/system 顺序可能错乱，导致切割错位。
--   改用单调 seq 作稳定排序键。
--
--   设计：全局自增（非按对话）。全局单调即蕴含"对话内单调"（查询恒 WHERE conversationId
--   ORDER BY seq）；seq 由 DB 自增赋值，应用写入点无需赋值。@unique 既满足 MySQL"自增列
--   须为某键首列"，又给 orderBy seq 提供索引。createdAt 列保留（前端 timestamp 仍用）。
--   幂等性：本迁移含 DDL，非幂等；靠 _prisma_migrations 记录保证只应用一次（migrate deploy）。

-- 1) 先加可空列（不带自增），供回填
ALTER TABLE `ConversationMessage` ADD COLUMN `seq` BIGINT NULL;

-- 2) 按 createdAt（同毫秒用 id 兜底）全局升序回填单调序号，保证历史消息顺序与既有
--    createdAt 排序完全一致。用 ROW_NUMBER() + 物化派生表（避免边读边写的未定义行为）。
UPDATE `ConversationMessage` `cm`
JOIN (
  SELECT `id`, ROW_NUMBER() OVER (ORDER BY `createdAt` ASC, `id` ASC) AS `rn`
  FROM `ConversationMessage`
) `ranked` ON `ranked`.`id` = `cm`.`id`
SET `cm`.`seq` = `ranked`.`rn`;

-- 3) 转 NOT NULL + AUTO_INCREMENT。MySQL 要求自增列必须是某键的首列，故先建唯一索引
--    再 MODIFY；MODIFY 后表的 AUTO_INCREMENT 计数器自动取 max(seq)+1（空表则为 1）。
ALTER TABLE `ConversationMessage` ADD UNIQUE INDEX `ConversationMessage_seq_key` (`seq`);
ALTER TABLE `ConversationMessage` MODIFY COLUMN `seq` BIGINT NOT NULL AUTO_INCREMENT;

-- 4) 切换有序索引：加 (conversationId, seq)，删旧 (conversationId, createdAt)
CREATE INDEX `ConversationMessage_conversationId_seq_idx` ON `ConversationMessage`(`conversationId`, `seq`);
DROP INDEX `ConversationMessage_conversationId_createdAt_idx` ON `ConversationMessage`;
