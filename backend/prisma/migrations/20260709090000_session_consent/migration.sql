-- Biometric-processing consent proof (NDPA lawful basis; CBN-aligned CDD).
-- Recorded once per session when the user accepts the SDK consent screen.

-- AlterTable
ALTER TABLE `verification_sessions`
    ADD COLUMN `consent_at` DATETIME(3) NULL,
    ADD COLUMN `consent_meta` JSON NULL;
