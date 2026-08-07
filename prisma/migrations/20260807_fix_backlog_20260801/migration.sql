-- FIX_BACKLOG_20260801 batch: additive columns only, every one nullable or defaulted.
-- Repo convention: migrations/ is a record; the DB is synced with `prisma db push`.
--   npx prisma db push --accept-data-loss
-- (the "data loss" warning is only about the new UNIQUE on JobQueue.activeKey, which is
--  brand-new and NULL for every existing row — MySQL permits duplicate NULLs, so it cannot fail)

-- P5-5: immutable per-session billing ledger column; reconciliation reads this instead of
-- recomputing expected from mutable Session state x the *current* multiplier.
ALTER TABLE `Session` ADD COLUMN `billedMinutes` INT NOT NULL DEFAULT 0;

-- P3-15: lock the ISO-4217 currency at checkout so callbacks can compare (amount, currency).
ALTER TABLE `PaymentOrder` ADD COLUMN `currency` VARCHAR(191) NOT NULL DEFAULT 'CNY';
-- P3-16: refund / chargeback terminal marker.
ALTER TABLE `PaymentOrder` ADD COLUMN `refundedAt` DATETIME(3) NULL;

-- P5-16: mutex key held only while a job is non-terminal ("audio_enhance:{sessionId}").
ALTER TABLE `JobQueue` ADD COLUMN `activeKey` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `JobQueue_activeKey_key` ON `JobQueue`(`activeKey`);

-- Backfill: jobs already in flight when this ships would carry activeKey = NULL, so the
-- uniqueness guarantee would not cover them until their first terminal transition — exactly
-- the deploy-time window where a duplicate enqueue is most likely. Claim the key for them now.
-- The GROUP BY keeps the oldest row per session: if duplicates already exist (the very bug this
-- closes), only one can hold the key, and the rest settle normally without it.
UPDATE `JobQueue` SET `activeKey` = CONCAT('audio_enhance:', `sessionId`)
WHERE `id` IN (
  SELECT `id` FROM (
    SELECT MIN(`id`) AS `id`
    FROM `JobQueue`
    WHERE `type` = 'audio_enhance'
      AND `status` IN ('SUBMITTED', 'PENDING', 'PROCESSING')
      AND `sessionId` IS NOT NULL
    GROUP BY `sessionId`
  ) AS `oldest_per_session`
);
