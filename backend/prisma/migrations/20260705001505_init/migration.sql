-- CreateTable
CREATE TABLE `tenants` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_uid` VARCHAR(64) NOT NULL,
    `company_name` VARCHAR(255) NOT NULL,
    `status` ENUM('sandbox', 'active', 'suspended', 'disabled') NOT NULL DEFAULT 'sandbox',
    `webhook_url` TEXT NULL,
    `webhook_secret` VARCHAR(128) NULL,
    `allowed_domains` JSON NULL,
    `settings` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `tenants_tenant_uid_key`(`tenant_uid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_keys` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NOT NULL,
    `key_type` ENUM('public', 'secret') NOT NULL,
    `is_live` BOOLEAN NOT NULL DEFAULT false,
    `key_hash` VARCHAR(255) NOT NULL,
    `prefix` VARCHAR(32) NOT NULL,
    `status` ENUM('active', 'revoked') NOT NULL DEFAULT 'active',
    `expires_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revoked_at` DATETIME(3) NULL,

    INDEX `api_keys_prefix_idx`(`prefix`),
    INDEX `api_keys_tenant_id_idx`(`tenant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NULL,
    `email` VARCHAR(255) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `role` ENUM('super_admin', 'tenant_admin', 'compliance_reviewer', 'developer', 'auditor') NOT NULL,
    `mfa_secret` VARCHAR(128) NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'active',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `users_email_key`(`email`),
    INDEX `users_tenant_id_idx`(`tenant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `verification_sessions` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `session_uid` VARCHAR(64) NOT NULL,
    `tenant_id` BIGINT NOT NULL,
    `customer_reference` VARCHAR(128) NULL,
    `verification_type` VARCHAR(64) NULL,
    `document_types` JSON NULL,
    `callback_url` TEXT NULL,
    `metadata` JSON NULL,
    `sdk_token_hash` VARCHAR(255) NULL,
    `device_fingerprint` VARCHAR(64) NULL,
    `device_meta` JSON NULL,
    `client_ip` VARCHAR(64) NULL,
    `status` ENUM('created', 'started', 'submitted', 'approved', 'rejected', 'manual_review', 'expired', 'failed', 'abandoned') NOT NULL DEFAULT 'created',
    `risk_level` ENUM('low', 'medium', 'high') NULL,
    `decision_reason` JSON NULL,
    `is_live` BOOLEAN NOT NULL DEFAULT false,
    `expires_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `verification_sessions_session_uid_key`(`session_uid`),
    INDEX `verification_sessions_tenant_id_status_idx`(`tenant_id`, `status`),
    INDEX `verification_sessions_tenant_id_customer_reference_idx`(`tenant_id`, `customer_reference`),
    INDEX `verification_sessions_tenant_id_device_fingerprint_idx`(`tenant_id`, `device_fingerprint`),
    INDEX `verification_sessions_tenant_id_client_ip_idx`(`tenant_id`, `client_ip`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `verification_results` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `session_id` BIGINT NOT NULL,
    `liveness_score` DECIMAL(5, 4) NULL,
    `liveness_status` ENUM('passed', 'failed', 'review') NULL,
    `face_match_score` DECIMAL(5, 4) NULL,
    `face_match_status` ENUM('matched', 'not_matched', 'review') NULL,
    `document_status` ENUM('valid', 'invalid', 'review') NULL,
    `ocr_confidence` DECIMAL(5, 4) NULL,
    `extracted_data` JSON NULL,
    `raw_result` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `verification_results_session_id_idx`(`session_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `evidence_files` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `session_id` BIGINT NOT NULL,
    `file_type` ENUM('id_front', 'id_back', 'selfie', 'liveness_frame', 'audit_pdf') NOT NULL,
    `storage_path` TEXT NOT NULL,
    `checksum` VARCHAR(128) NULL,
    `encrypted` BOOLEAN NOT NULL DEFAULT true,
    `retention_expires_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `evidence_files_session_id_idx`(`session_id`),
    INDEX `evidence_files_retention_expires_at_idx`(`retention_expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `manual_review_notes` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `session_id` BIGINT NOT NULL,
    `user_id` BIGINT NOT NULL,
    `decision` VARCHAR(32) NULL,
    `note` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `manual_review_notes_session_id_idx`(`session_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT NULL,
    `session_id` BIGINT NULL,
    `actor_type` ENUM('system', 'tenant_user', 'admin', 'api') NOT NULL,
    `actor_id` VARCHAR(128) NULL,
    `action` VARCHAR(128) NOT NULL,
    `ip_address` VARCHAR(64) NULL,
    `user_agent` TEXT NULL,
    `metadata` JSON NULL,
    `risk_event` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_tenant_id_created_at_idx`(`tenant_id`, `created_at`),
    INDEX `audit_logs_session_id_idx`(`session_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_deliveries` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `event_uid` VARCHAR(64) NOT NULL,
    `tenant_id` BIGINT NOT NULL,
    `session_id` BIGINT NULL,
    `event` VARCHAR(64) NOT NULL,
    `payload` JSON NOT NULL,
    `url` TEXT NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `last_status_code` INTEGER NULL,
    `last_error` TEXT NULL,
    `next_attempt_at` DATETIME(3) NULL,
    `delivered_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `webhook_deliveries_event_uid_key`(`event_uid`),
    INDEX `webhook_deliveries_tenant_id_status_idx`(`tenant_id`, `status`),
    INDEX `webhook_deliveries_status_next_attempt_at_idx`(`status`, `next_attempt_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_queue` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `type` VARCHAR(64) NOT NULL,
    `payload` JSON NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `max_attempts` INTEGER NOT NULL DEFAULT 5,
    `run_after` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `locked_by` VARCHAR(64) NULL,
    `locked_at` DATETIME(3) NULL,
    `last_error` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `job_queue_status_run_after_idx`(`status`, `run_after`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `api_keys` ADD CONSTRAINT `api_keys_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `verification_sessions` ADD CONSTRAINT `verification_sessions_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `verification_results` ADD CONSTRAINT `verification_results_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `verification_sessions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `evidence_files` ADD CONSTRAINT `evidence_files_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `verification_sessions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `manual_review_notes` ADD CONSTRAINT `manual_review_notes_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `verification_sessions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
