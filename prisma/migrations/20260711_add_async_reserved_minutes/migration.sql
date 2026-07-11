-- B1（异步上传计费门禁加固）：Session 新增 asyncReservedMinutes —— 异步上传转录入口原子
-- 配额预留的分钟数。init 预留成功后写入（同时已计入 User.transcriptionMinutesUsed）；
-- finalize 时转为实扣、cancel/删会话/失败回收时释放。非 0 即表示有一笔在途预留待结算。

-- AlterTable
ALTER TABLE `Session` ADD COLUMN `asyncReservedMinutes` INTEGER NOT NULL DEFAULT 0;
