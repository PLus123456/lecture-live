-- B3（同声传译服务端兜底扣费）：InterpretSession 持久化同传会话。/start 落一行(settledAt=null)，
-- /deduct 成功扣费时原子认领(设 settledAt)，cron 对超时未结算的按服务端墙钟兜底扣费并结算。
-- deduct 与 cron 经 settledAt 条件认领互斥 → 每场恰好扣一次。

-- CreateTable
CREATE TABLE `InterpretSession` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `anchorId` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `settledAt` DATETIME(3) NULL,
    `billedMinutes` INTEGER NULL,
    `settledBy` VARCHAR(191) NULL,

    INDEX `InterpretSession_settledAt_startedAt_idx`(`settledAt`, `startedAt`),
    INDEX `InterpretSession_userId_settledAt_idx`(`userId`, `settledAt`),
    INDEX `InterpretSession_anchorId_idx`(`anchorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
