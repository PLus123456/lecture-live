-- SEC-010/012/021 shared resource admission: durable per-job reservation leases.
-- A reservation is held while the JobQueue row is non-terminal; terminal CAS records actual
-- usage, releases only the unused part, and leaves actual usage charged to the admission window.
-- Numeric columns keep admission queryable/auditable without parsing JSON.
ALTER TABLE `JobQueue`
  ADD COLUMN `resourceScope` VARCHAR(191) NULL,
  ADD COLUMN `reservedUnits` BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN `actualUnits` BIGINT NULL;

CREATE INDEX `JobQueue_resourceScope_status_completedAt_idx`
  ON `JobQueue`(`resourceScope`, `status`, `completedAt`);
CREATE INDEX `JobQueue_resourceScope_userId_status_completedAt_idx`
  ON `JobQueue`(`resourceScope`, `userId`, `status`, `completedAt`);
CREATE INDEX `JobQueue_resourceScope_type_sessionId_status_idx`
  ON `JobQueue`(`resourceScope`, `type`, `sessionId`, `status`);
