-- Bulk certificate generation: batches + recipients + serial sequences
-- Slice 2: ingestion + mapping. Recipient rows are materialized at batch start (Slice 3).

CREATE TABLE IF NOT EXISTS cert_batches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  template_id BIGINT UNSIGNED NOT NULL,
  status ENUM('DRAFT','READY','RENDERING','RENDERED','FAILED','DISTRIBUTING','COMPLETED','CANCELLED')
    NOT NULL DEFAULT 'DRAFT',
  source_filename VARCHAR(500) NOT NULL,
  source_content_type VARCHAR(128) NOT NULL,
  source_s3_key VARCHAR(1000) NOT NULL,
  source_size_bytes INT UNSIGNED NOT NULL DEFAULT 0,
  detected_columns_json JSON,
  sample_rows_json JSON,
  column_mapping_json JSON,
  serial_config_json JSON,
  email_column VARCHAR(255),
  name_column VARCHAR(255),
  total_rows INT UNSIGNED NOT NULL DEFAULT 0,
  rendered_count INT UNSIGNED NOT NULL DEFAULT 0,
  failed_count INT UNSIGNED NOT NULL DEFAULT 0,
  sent_count INT UNSIGNED NOT NULL DEFAULT 0,
  email_campaign_id BIGINT UNSIGNED,
  created_by BIGINT UNSIGNED,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  KEY idx_cert_batch_status (status),
  KEY idx_cert_batch_template (template_id),
  KEY idx_cert_batch_campaign (email_campaign_id),
  CONSTRAINT fk_cert_batch_template FOREIGN KEY (template_id) REFERENCES cert_templates(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Each cert_recipient is one rendered certificate. Designed for up to ~1M rows per batch:
--   - serial_no and verification_code are pre-assigned at materialization, so render
--     workers never contend for sequences.
--   - covering index on (batch_id, status) supports the worker's "give me PENDING for
--     this batch" scan without sorting.
--   - verification_code is globally unique with its own index for public lookup.
CREATE TABLE IF NOT EXISTS cert_recipients (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id BIGINT UNSIGNED NOT NULL,
  row_index INT UNSIGNED NOT NULL,
  serial_no VARCHAR(128) NOT NULL,
  verification_code CHAR(24) NOT NULL,
  email VARCHAR(320),
  full_name VARCHAR(500),
  row_data_json JSON NOT NULL,
  status ENUM('PENDING','RENDERING','RENDERED','FAILED','SENT','DOWNLOADED')
    NOT NULL DEFAULT 'PENDING',
  cert_s3_key VARCHAR(1000),
  error_reason TEXT,
  retry_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  ses_message_id VARCHAR(255),
  rendered_at TIMESTAMP NULL,
  sent_at TIMESTAMP NULL,
  delivered_at TIMESTAMP NULL,
  downloaded_at TIMESTAMP NULL,
  download_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_downloaded_ip VARCHAR(64),
  PRIMARY KEY (id),
  UNIQUE KEY uk_cert_recipient_code (verification_code),
  UNIQUE KEY uk_cert_recipient_serial_batch (batch_id, serial_no),
  KEY idx_cert_recipient_status (batch_id, status),
  KEY idx_cert_recipient_email_batch (email, batch_id),
  KEY idx_cert_recipient_message (ses_message_id),
  CONSTRAINT fk_cert_recipient_batch FOREIGN KEY (batch_id) REFERENCES cert_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per batch. Stores serial-number configuration plus the counter cursor.
-- Recipients are pre-numbered at materialization, so this is mainly an audit record
-- of how serials were generated.
CREATE TABLE IF NOT EXISTS cert_serial_sequences (
  batch_id BIGINT UNSIGNED NOT NULL,
  prefix VARCHAR(32) NOT NULL DEFAULT '',
  suffix VARCHAR(32) NOT NULL DEFAULT '',
  padding_width TINYINT UNSIGNED NOT NULL DEFAULT 4,
  start_at INT UNSIGNED NOT NULL DEFAULT 1,
  current_value INT UNSIGNED NOT NULL DEFAULT 1,
  end_at INT UNSIGNED,
  PRIMARY KEY (batch_id),
  CONSTRAINT fk_cert_serial_batch FOREIGN KEY (batch_id) REFERENCES cert_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cert_audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED,
  action VARCHAR(64) NOT NULL,
  batch_id BIGINT UNSIGNED,
  template_id BIGINT UNSIGNED,
  metadata JSON,
  ip VARCHAR(64),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cert_audit_batch (batch_id),
  KEY idx_cert_audit_template (template_id),
  KEY idx_cert_audit_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
