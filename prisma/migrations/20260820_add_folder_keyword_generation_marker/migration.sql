ALTER TABLE `FolderSession`
  ADD COLUMN `folderKeywordSourceHash` VARCHAR(64) NULL,
  ADD COLUMN `folderKeywordGeneratedAt` DATETIME(3) NULL;
