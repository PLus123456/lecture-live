-- 上传文件转录走 Soniox async file API 的进度跟踪字段。
--
-- 流程：浏览器分片上传 → 后端合并 → ffmpeg 抽音频压成 MP3 → POST /v1/files
-- → POST /v1/transcriptions → poll GET /v1/transcriptions/{id} → 拿 transcript
-- → DELETE /v1/files/{id} 释放 Soniox 配额。
--
-- 状态机：uploading_chunks → transcoding → uploading_to_soniox
-- → transcribing → completed / failed

ALTER TABLE `Session`
  ADD COLUMN `sonioxFileId` VARCHAR(191) NULL,
  ADD COLUMN `sonioxTranscriptionId` VARCHAR(191) NULL,
  ADD COLUMN `asyncTranscribeStatus` VARCHAR(191) NULL,
  ADD COLUMN `asyncTranscribeError` TEXT NULL,
  ADD COLUMN `asyncTranscribeStartedAt` DATETIME(3) NULL;

CREATE INDEX `Session_asyncTranscribeStatus_idx` ON `Session`(`asyncTranscribeStatus`);
