ALTER TABLE `RecentSearch`
  ADD COLUMN `requestId` VARCHAR(36) NULL,
  ADD UNIQUE INDEX `RecentSearch_userId_requestId_key`(`userId`, `requestId`);
