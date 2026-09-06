ALTER TABLE `RecentSearch`
  ADD COLUMN `queryKey` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL;

UPDATE `RecentSearch`
SET `queryKey` = SHA2(
  LOWER(REGEXP_REPLACE(TRIM(`query`), '[[:space:]]+', ' ')),
  256
);

DELETE older
FROM `RecentSearch` older
JOIN `RecentSearch` newer
  ON newer.`userId` = older.`userId`
  AND newer.`locale` = older.`locale`
  AND newer.`queryKey` = older.`queryKey`
  AND (
    newer.`createdAt` > older.`createdAt`
    OR (newer.`createdAt` = older.`createdAt` AND newer.`id` > older.`id`)
  );

ALTER TABLE `RecentSearch`
  ADD UNIQUE INDEX `RecentSearch_userId_locale_queryKey_key`(`userId`, `locale`, `queryKey`);
