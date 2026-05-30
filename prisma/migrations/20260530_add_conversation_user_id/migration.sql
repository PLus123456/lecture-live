-- 给 Conversation 加 userId 列（鉴权根因修复）：
--   背景：此前 Conversation 无 userId 列，归属只能靠录音反推，留下"零录音纯 global
--   对话宽进"和"混合权限放行"两个越权面。此迁移加列 + 回填历史归属，之后所有归属判断
--   点统一改用 userId。
--
--   列设计：可空。仅为兼容历史"零录音纯 global 对话"（无 sessionId、无 ConversationSession、
--   无 ChatAttachment —— 完全无反推材料的孤儿）。回填后这类孤儿仍为 NULL，代码侧把 NULL
--   当"无主"（列表不显示 + 访问一律 404）。新建对话由服务端恒写 userId，实质非空。
--   与 ChatAttachment.userId 同规约：纯冗余列，不建外键 relation。

-- AlterTable
ALTER TABLE `Conversation` ADD COLUMN `userId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Conversation_userId_idx` ON `Conversation`(`userId`);

-- ─── 回填历史归属（幂等：每条 UPDATE 都带 `userId IS NULL` 守卫，可安全重跑） ───

-- 类别 1：legacy 单录音对话（sessionId 非空）→ 该 Session 的 owner
UPDATE `Conversation` `c`
  JOIN `Session` `s` ON `s`.`id` = `c`.`sessionId`
  SET `c`.`userId` = `s`.`userId`
  WHERE `c`.`userId` IS NULL AND `c`.`sessionId` IS NOT NULL;

-- 类别 2：多录音全局对话（sessionId 空，但挂了 ConversationSession）→ 挂载 Session 的 owner
--   挂载时已校验"录音必须属于当前用户"，故同一对话的挂载录音同属一人；用 MIN 取确定值。
UPDATE `Conversation` `c`
  JOIN (
    SELECT `cs`.`conversationId` AS `cid`, MIN(`s`.`userId`) AS `uid`
    FROM `ConversationSession` `cs`
    JOIN `Session` `s` ON `s`.`id` = `cs`.`sessionId`
    GROUP BY `cs`.`conversationId`
  ) `j` ON `j`.`cid` = `c`.`id`
  SET `c`.`userId` = `j`.`uid`
  WHERE `c`.`userId` IS NULL;

-- 类别 3：仅有附件的全局对话（无 sessionId、无 ConversationSession，但有 ChatAttachment）
--   → 附件上传者。绝大多数情况附件同属一人；历史孤儿"宽进"理论上可能有多人写入，用 MIN
--     取确定值（极端共享孤儿场景下其余人将失去访问，可接受）。
UPDATE `Conversation` `c`
  JOIN (
    SELECT `a`.`conversationId` AS `cid`, MIN(`a`.`userId`) AS `uid`
    FROM `ChatAttachment` `a`
    GROUP BY `a`.`conversationId`
  ) `j` ON `j`.`cid` = `c`.`id`
  SET `c`.`userId` = `j`.`uid`
  WHERE `c`.`userId` IS NULL;

-- 类别 4：完全无反推材料的孤儿 → 保留 userId = NULL（代码侧当"无主"，不可见 + 拒访问）。
