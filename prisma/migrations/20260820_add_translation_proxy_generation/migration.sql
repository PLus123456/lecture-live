-- SEC-021: distinguish dispatch generations even when an automatic retry reuses
-- the same doc_translate JobQueue row id.
ALTER TABLE `TranslationTask`
  ADD COLUMN `proxyGeneration` VARCHAR(64) NULL;
