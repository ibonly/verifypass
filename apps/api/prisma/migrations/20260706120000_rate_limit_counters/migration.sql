-- Shared fixed-window rate-limit counters (multi-process safe rate limiting).
-- One row per limiter+key+window bucket; swept by retention_cleanup.

-- CreateTable
CREATE TABLE `rate_limit_counters` (
    `key` VARCHAR(191) NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 0,
    `window_ends_at` DATETIME(3) NOT NULL,

    INDEX `rate_limit_counters_window_ends_at_idx`(`window_ends_at`),
    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
