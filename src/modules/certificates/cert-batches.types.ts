export type CertBatchStatus =
  | 'DRAFT'
  | 'READY'
  | 'RENDERING'
  | 'RENDERED'
  | 'FAILED'
  | 'DISTRIBUTING'
  | 'COMPLETED'
  | 'CANCELLED';

export interface SerialConfig {
  prefix?: string;
  suffix?: string;
  paddingWidth?: number;
  startAt?: number;
}

export interface CertBatchRow {
  id: number;
  name: string;
  template_id: number;
  status: CertBatchStatus;
  source_filename: string;
  source_content_type: string;
  source_s3_key: string;
  source_size_bytes: number;
  detected_columns_json: string[] | null;
  sample_rows_json: Record<string, string>[] | null;
  column_mapping_json: Record<string, string> | null; // placeholder_key -> column_name
  serial_config_json: SerialConfig | null;
  email_column: string | null;
  name_column: string | null;
  total_rows: number;
  rendered_count: number;
  failed_count: number;
  sent_count: number;
  email_campaign_id: number | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface CertBatchWithUrls extends CertBatchRow {
  source_url: string;
}

export interface CreateBatchInput {
  name: string;
  templateId: number;
  file: {
    filename: string;
    contentType: string;
    data: string; // base64
  };
}

export interface SaveMappingInput {
  columnMapping: Record<string, string>; // placeholderKey -> sourceColumn
  serialConfig?: SerialConfig;
  emailColumn?: string | null;
  nameColumn?: string | null;
}
