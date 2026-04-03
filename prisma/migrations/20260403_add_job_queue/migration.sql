-- CreateTable: 后台任务队列
CREATE TABLE `JobQueue` (
    `id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'SUBMITTED',
    `params` TEXT NULL,
    `result` TEXT NULL,
    `error` TEXT NULL,
    `sessionId` VARCHAR(191) NULL,
    `userId` VARCHAR(191) NULL,
    `triggeredBy` VARCHAR(191) NULL,
    `attempt` INTEGER NOT NULL DEFAULT 1,
    `maxAttempts` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,

    INDEX `JobQueue_type_idx`(`type`),
    INDEX `JobQueue_status_idx`(`status`),
    INDEX `JobQueue_sessionId_idx`(`sessionId`),
    INDEX `JobQueue_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
