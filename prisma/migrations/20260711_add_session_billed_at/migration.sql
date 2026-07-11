-- B7（对账按扣费时刻归期）：Session 新增 billedAt —— 转录分钟被扣费的时刻(realtime/异步上传/完整版
-- finalize 时置)。对账按 billedAt 归期(而非 createdAt)，修跨月/延迟收尾/自动回收会话被算错周期的虚报 drift。

-- AlterTable
ALTER TABLE `Session` ADD COLUMN `billedAt` DATETIME(3) NULL;
