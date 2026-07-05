-- AlterTable
ALTER TABLE `evidence_files` ADD COLUMN `label` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `verification_sessions` ADD COLUMN `liveness_challenge` JSON NULL;
