-- 给 Conversation 加 archived 列（用户主动归档）。
--   语义：关闭(endedAt 非空) ≠ 归档。关闭只是只读但仍在主列表；archived 表示用户主动归档，
--   从 /chat 主列表隐藏，移入「对话历史」页的归档区。
--   默认 false，非空；历史行自动取默认值，无需回填。
--   归属/可见性仍以 userId 判定；列表查询按需追加 WHERE archived = false（既有 userId 索引足够）。

-- AlterTable
ALTER TABLE `Conversation` ADD COLUMN `archived` BOOLEAN NOT NULL DEFAULT false;
