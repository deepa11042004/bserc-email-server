-- Bulk certificate generation & delivery module
-- Slice 1: template storage and placeholder positioning (rendering/batches in later slices)

CREATE TABLE IF NOT EXISTS cert_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  description VARCHAR(1000),
  image_s3_key VARCHAR(1000) NOT NULL,
  image_content_type VARCHAR(64) NOT NULL,
  image_width INT UNSIGNED NOT NULL,
  image_height INT UNSIGNED NOT NULL,
  image_size_bytes INT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  created_by BIGINT UNSIGNED,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cert_template_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cert_placeholders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  template_id BIGINT UNSIGNED NOT NULL,
  placeholder_key VARCHAR(64) NOT NULL,
  x INT NOT NULL,
  y INT NOT NULL,
  width INT UNSIGNED NOT NULL DEFAULT 0,
  height INT UNSIGNED NOT NULL DEFAULT 0,
  font_family VARCHAR(128) NOT NULL DEFAULT 'Helvetica',
  font_size_pt INT UNSIGNED NOT NULL DEFAULT 18,
  font_color_hex CHAR(7) NOT NULL DEFAULT '#000000',
  font_weight ENUM('NORMAL','BOLD') NOT NULL DEFAULT 'NORMAL',
  text_align ENUM('LEFT','CENTER','RIGHT') NOT NULL DEFAULT 'CENTER',
  is_qr TINYINT(1) NOT NULL DEFAULT 0,
  is_serial TINYINT(1) NOT NULL DEFAULT 0,
  max_length SMALLINT UNSIGNED NOT NULL DEFAULT 200,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_placeholder_template_key (template_id, placeholder_key),
  KEY idx_placeholder_template (template_id),
  CONSTRAINT fk_placeholder_template FOREIGN KEY (template_id) REFERENCES cert_templates(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
