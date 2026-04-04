-- AlterTable: 添加自定义用户组 ID 字段
ALTER TABLE `User` ADD COLUMN `customGroupId` VARCHAR(191) NULL;
