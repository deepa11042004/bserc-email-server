-- Bulk email notification platform schema (MySQL 8+)

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INT NOT NULL,
  filename VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  role ENUM('ADMIN','OPERATOR','VIEWER') NOT NULL DEFAULT 'OPERATOR',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  template_code VARCHAR(64) NOT NULL,
  template_name VARCHAR(255) NOT NULL,
  subject VARCHAR(998) NOT NULL,
  html_body MEDIUMTEXT NOT NULL,
  text_body MEDIUMTEXT,
  status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  created_by BIGINT UNSIGNED,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_template_code (template_code),
  KEY idx_template_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaigns (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_name VARCHAR(255) NOT NULL,
  template_id BIGINT UNSIGNED NOT NULL,
  from_email VARCHAR(255) NOT NULL,
  reply_to VARCHAR(255),
  source_type ENUM('API','DB_TABLE','SQL_QUERY') NOT NULL,
  source_meta JSON,
  global_vars JSON,
  status ENUM('DRAFT','QUEUED','RUNNING','PAUSED','COMPLETED','FAILED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  total_recipients INT UNSIGNED NOT NULL DEFAULT 0,
  queued_count INT UNSIGNED NOT NULL DEFAULT 0,
  sent_count INT UNSIGNED NOT NULL DEFAULT 0,
  failed_count INT UNSIGNED NOT NULL DEFAULT 0,
  bounced_count INT UNSIGNED NOT NULL DEFAULT 0,
  complaint_count INT UNSIGNED NOT NULL DEFAULT 0,
  delivered_count INT UNSIGNED NOT NULL DEFAULT 0,
  suppressed_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  KEY idx_campaign_status (status),
  KEY idx_campaign_template (template_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id BIGINT UNSIGNED NOT NULL,
  email VARCHAR(320) NOT NULL,
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  payload_json JSON,
  status ENUM('PENDING','QUEUED','SENT','FAILED','BOUNCED','COMPLAINT','SUPPRESSED','DELIVERED') NOT NULL DEFAULT 'PENDING',
  ses_message_id VARCHAR(255),
  error_reason TEXT,
  retry_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  queued_at TIMESTAMP NULL,
  sent_at TIMESTAMP NULL,
  delivered_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  KEY idx_recipient_campaign (campaign_id),
  KEY idx_recipient_status (campaign_id, status),
  KEY idx_recipient_email (email),
  KEY idx_recipient_message (ses_message_id),
  CONSTRAINT fk_recipient_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id BIGINT UNSIGNED,
  recipient_id BIGINT UNSIGNED,
  event_type ENUM('Send','Delivery','Bounce','Complaint','Reject','Open','Click','RenderingFailure','DeliveryDelay','Subscription','Unknown') NOT NULL,
  provider_message_id VARCHAR(255),
  email VARCHAR(320),
  payload_json JSON,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_event_campaign (campaign_id),
  KEY idx_event_recipient (recipient_id),
  KEY idx_event_message (provider_message_id),
  KEY idx_event_type (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS suppression_list (
  email VARCHAR(320) NOT NULL,
  reason ENUM('BOUNCE','COMPLAINT','MANUAL','UNSUBSCRIBE') NOT NULL,
  notes VARCHAR(500),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(64),
  entity_id VARCHAR(64),
  metadata JSON,
  ip VARCHAR(64),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_user (user_id),
  KEY idx_audit_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
