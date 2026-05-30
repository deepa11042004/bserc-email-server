-- Track public verification lookups separately from downloads.
-- A "verification" is a hit on the public verify endpoint (audience: anyone with the code).
-- A "download" is a hit on the actual PDF S3 URL.

ALTER TABLE cert_recipients
  ADD COLUMN verification_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER download_count,
  ADD COLUMN last_verified_at TIMESTAMP NULL AFTER verification_count,
  ADD COLUMN last_verified_ip VARCHAR(64) AFTER last_verified_at;
