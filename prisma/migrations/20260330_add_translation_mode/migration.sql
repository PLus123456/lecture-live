-- AlterTable: 添加 translationMode 字段，记录会话使用的翻译模式
ALTER TABLE `Session` ADD COLUMN `translationMode` VARCHAR(191) NOT NULL DEFAULT 'soniox';
