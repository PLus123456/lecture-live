-- Bind every full-transcribe state transition to the attempt that claimed it.
-- Nullable keeps already-running deployments and historical terminal rows compatible.
ALTER TABLE `Session`
  ADD COLUMN `fullTranscribeClaimId` VARCHAR(64) NULL;
