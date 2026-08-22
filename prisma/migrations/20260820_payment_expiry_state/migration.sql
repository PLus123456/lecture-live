-- SEC-029: late provider-confirmed payments are durable review states, never entitlement grants.
ALTER TABLE `PaymentOrder`
  ADD COLUMN `reviewReason` VARCHAR(191) NULL;
