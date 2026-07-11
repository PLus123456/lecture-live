-- R4（完整版补全转录计费门禁加固）：Session 新增 fullReservedMinutes —— 完整版补全转录入口
-- 原子配额预留的分钟数（与 B1 的 asyncReservedMinutes 平行）。触发预留成功后写入（同时已计入
-- User.transcriptionMinutesUsed）；finalize 时转为实扣、删会话/失败回收时释放。非 0 即表示有一笔
-- 在途预留待结算。

-- AlterTable
ALTER TABLE `Session` ADD COLUMN `fullReservedMinutes` INTEGER NOT NULL DEFAULT 0;
