export type CertTemplateStatus = 'ACTIVE' | 'DISABLED';
export type FontWeight = 'NORMAL' | 'BOLD';
export type TextAlign = 'LEFT' | 'CENTER' | 'RIGHT';

export interface CertTemplateRow {
  id: number;
  name: string;
  description: string | null;
  image_s3_key: string;
  image_content_type: string;
  image_width: number;
  image_height: number;
  image_size_bytes: number;
  status: CertTemplateStatus;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface CertTemplateWithUrl extends CertTemplateRow {
  image_url: string;
  placeholders?: CertPlaceholderRow[];
}

export interface CertPlaceholderRow {
  id: number;
  template_id: number;
  placeholder_key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  font_family: string;
  font_size_pt: number;
  font_color_hex: string;
  font_weight: FontWeight;
  text_align: TextAlign;
  is_qr: 0 | 1;
  is_serial: 0 | 1;
  max_length: number;
  sort_order: number;
}

export interface CreateCertTemplateInput {
  name: string;
  description?: string | null;
  image: {
    filename: string;
    contentType: string;
    data: string; // base64
  };
}

export interface UpdateCertTemplateInput {
  name?: string;
  description?: string | null;
  status?: CertTemplateStatus;
}

export interface PlaceholderInput {
  placeholderKey: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  fontFamily?: string;
  fontSizePt?: number;
  fontColorHex?: string;
  fontWeight?: FontWeight;
  textAlign?: TextAlign;
  isQr?: boolean;
  isSerial?: boolean;
  maxLength?: number;
  sortOrder?: number;
}
