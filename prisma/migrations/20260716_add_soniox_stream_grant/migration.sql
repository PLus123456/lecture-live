-- R1-L2（Soniox 直连串流计费闭环）：SonioxStreamGrant——临时 key 签发台账 + 预扣载体。
-- mint 时原子预扣 reservedMinutes（额度不足按剩余收缩、为 0 拒发），key 带
-- max_session_duration_seconds=预扣分钟（到点 Soniox 硬断连）+ single_use（一 key 一连接），
-- 单 key 可串流量恒 ≤ 已预扣量。结算经 settledAt 条件原子认领互斥：finalize/deduct/interpret-cron
-- 释放预留；usage cron 按 /v1/usage-logs 回填 actualMs，孤儿 grant 有用量转实扣、无用量退预扣。

-- CreateTable
CREATE TABLE `SonioxStreamGrant` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NULL,
    `interpretSessionId` VARCHAR(191) NULL,
    `region` VARCHAR(191) NOT NULL,
    `reservedMinutes` INTEGER NOT NULL,
    `maxSessionSeconds` INTEGER NOT NULL,
    `mintedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `settledAt` DATETIME(3) NULL,
    `settledBy` VARCHAR(191) NULL,
    `actualMs` INTEGER NULL,
    `usageLogUuid` VARCHAR(191) NULL,
    `billedMinutes` INTEGER NULL,

    INDEX `SonioxStreamGrant_userId_settledAt_idx`(`userId`, `settledAt`),
    INDEX `SonioxStreamGrant_settledAt_mintedAt_idx`(`settledAt`, `mintedAt`),
    INDEX `SonioxStreamGrant_sessionId_idx`(`sessionId`),
    INDEX `SonioxStreamGrant_interpretSessionId_idx`(`interpretSessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
