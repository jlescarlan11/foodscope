ALTER TABLE `User`
  ADD COLUMN `stripeCheckoutAttemptId` VARCHAR(36) NULL,
  ADD COLUMN `stripeCheckoutSessionId` VARCHAR(191) NULL,
  ADD COLUMN `stripeCheckoutSessionUrl` TEXT NULL,
  ADD COLUMN `stripeCheckoutExpiresAt` DATETIME(3) NULL,
  ADD UNIQUE INDEX `User_stripeCheckoutSessionId_key`(`stripeCheckoutSessionId`);
