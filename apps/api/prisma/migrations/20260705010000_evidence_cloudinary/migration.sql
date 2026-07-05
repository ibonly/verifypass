-- Cloudinary visual-evidence mirror: store the uploaded URL + public_id so
-- reviewers can compare a liveness frame against its required action.
ALTER TABLE `evidence_files`
  ADD COLUMN `cloudinary_url` TEXT NULL,
  ADD COLUMN `cloudinary_public_id` VARCHAR(255) NULL;
