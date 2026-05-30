import { appPool } from '../../db/pools.js';
import { env } from '../../config/env.js';
import { logger } from '../../common/logger.js';
import { downloadFromS3, uploadToS3 } from '../aws/s3.service.js';
import { renderCertificatePdf } from './cert-renderer.js';
import { getCertTemplate, listPlaceholders } from './cert-templates.service.js';
import { formatSerial } from './cert-materializer.js';
import type { SerialConfig } from './cert-batches.types.js';
import type { CertPlaceholderRow } from './cert-templates.types.js';

/**
 * Resolve the full set of values for placeholder substitution on a single recipient row.
 * Auto-generated placeholders (is_serial / is_qr) are filled in here; mapped placeholders
 * are pulled from row_data_json via the batch's column_mapping.
 */
export const buildValuesForRow = (
  placeholders: CertPlaceholderRow[],
  columnMapping: Record<string, string>,
  rowData: Record<string, string>,
  serialNo: string,
  verificationUrl: string
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const p of placeholders) {
    if (p.is_qr) continue; // rendered as image, not text
    if (p.is_serial) { out[p.placeholder_key] = serialNo; continue; }
    const col = columnMapping[p.placeholder_key];
    if (col) out[p.placeholder_key] = String(rowData[col] ?? '');
  }
  // also expose verification url for any non-qr placeholder that wants to print it
  if (!out['verification_url']) out['verification_url'] = verificationUrl;
  return out;
};

const recipientShardPrefix = (recipientId: number): string =>
  String(recipientId % 100).padStart(2, '0');

export const certS3KeyFor = (batchId: number, recipientId: number): string =>
  `certs/${batchId}/${recipientShardPrefix(recipientId)}/${recipientId}.pdf`;

interface RenderContext {
  templateImageBytes: Buffer;
  templateContentType: string;
  templateWidth: number;
  templateHeight: number;
  placeholders: CertPlaceholderRow[];
  columnMapping: Record<string, string>;
  serialConfig: SerialConfig | null;
}

const loadBatchRenderContext = async (batchId: number): Promise<RenderContext> => {
  const [rows]: any = await appPool().query(
    `SELECT b.id, b.template_id, b.column_mapping_json, b.serial_config_json,
            t.image_s3_key, t.image_content_type, t.image_width, t.image_height
       FROM cert_batches b
       JOIN cert_templates t ON t.id = b.template_id
      WHERE b.id = ? LIMIT 1`,
    [batchId]
  );
  const row = rows[0];
  if (!row) throw new Error(`Batch ${batchId} not found`);
  const placeholders = await listPlaceholders(row.template_id);
  const imageBytes = await downloadFromS3(row.image_s3_key);
  const parse = (v: unknown): any => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(String(v)); } catch { return null; }
  };
  return {
    templateImageBytes: imageBytes,
    templateContentType: row.image_content_type,
    templateWidth: row.image_width,
    templateHeight: row.image_height,
    placeholders,
    columnMapping: parse(row.column_mapping_json) ?? {},
    serialConfig: parse(row.serial_config_json),
  };
};

interface RecipientRow {
  id: number;
  batch_id: number;
  serial_no: string;
  verification_code: string;
  row_data_json: string | Record<string, string>;
  status: string;
  retry_count: number;
}

const loadRecipient = async (id: number): Promise<RecipientRow> => {
  const [rows]: any = await appPool().query(
    'SELECT * FROM cert_recipients WHERE id = ? LIMIT 1',
    [id]
  );
  const row = rows[0];
  if (!row) throw new Error(`Recipient ${id} not found`);
  return row as RecipientRow;
};

const parseRowData = (raw: unknown): Record<string, string> => {
  if (raw && typeof raw === 'object') return raw as Record<string, string>;
  try { return JSON.parse(String(raw ?? '{}')); } catch { return {}; }
};

const verificationUrlFor = (code: string): string =>
  `${env.CERT_VERIFY_BASE_URL.replace(/\/$/, '')}/${code}`;

/**
 * Render a single recipient's certificate to a buffer. Pure-ish: reads template + recipient,
 * does not write back to DB. Used by both the worker (which then uploads + updates) and the
 * synchronous preview endpoint (which uploads to a scratch key).
 */
export const renderRecipientPdf = async (
  batchId: number,
  recipientId: number,
  ctx?: RenderContext
): Promise<{ pdf: Buffer; recipient: RecipientRow }> => {
  const recipient = await loadRecipient(recipientId);
  if (recipient.batch_id !== batchId) throw new Error('Recipient does not belong to batch');
  const context = ctx ?? (await loadBatchRenderContext(batchId));
  const rowData = parseRowData(recipient.row_data_json);
  const verificationUrl = verificationUrlFor(recipient.verification_code);
  const values = buildValuesForRow(
    context.placeholders,
    context.columnMapping,
    rowData,
    recipient.serial_no,
    verificationUrl
  );
  const pdf = await renderCertificatePdf({
    templateImage: {
      bytes: context.templateImageBytes,
      contentType: context.templateContentType,
      width: context.templateWidth,
      height: context.templateHeight,
    },
    placeholders: context.placeholders,
    values,
    verificationUrl,
  });
  return { pdf, recipient };
};

/**
 * Full process-one-job pipeline used by the worker.
 *  1. Mark recipient RENDERING (so retries are observable)
 *  2. Render PDF
 *  3. Upload to S3 at the canonical sharded key
 *  4. Mark recipient RENDERED + cert_s3_key
 *  5. Bump cert_batches.rendered_count
 * Errors are caught by the caller, which decides retry vs. mark FAILED.
 */
export const processCertJob = async (batchId: number, recipientId: number): Promise<void> => {
  // Optimistic transition; if another worker already grabbed it, this becomes a no-op.
  const [upd]: any = await appPool().query(
    `UPDATE cert_recipients SET status = 'RENDERING'
       WHERE id = ? AND status IN ('PENDING','FAILED')`,
    [recipientId]
  );
  if (upd.affectedRows === 0) {
    // Already done or in-flight elsewhere — drop silently.
    logger.debug({ recipientId }, 'Cert job skipped (recipient not in PENDING/FAILED)');
    return;
  }

  try {
    const { pdf, recipient } = await renderRecipientPdf(batchId, recipientId);
    const key = certS3KeyFor(batchId, recipientId);
    await uploadToS3(key, pdf, 'application/pdf');
    await appPool().query(
      `UPDATE cert_recipients
          SET status = 'RENDERED', cert_s3_key = ?, rendered_at = NOW(), error_reason = NULL
        WHERE id = ?`,
      [key, recipientId]
    );
    await appPool().query(
      `UPDATE cert_batches SET rendered_count = rendered_count + 1 WHERE id = ?`,
      [batchId]
    );
    void recipient; // silence unused-warn; we may use later for logging
  } catch (e: any) {
    const message = (e?.message ?? String(e)).slice(0, 1000);
    await appPool().query(
      `UPDATE cert_recipients
          SET status = 'FAILED', error_reason = ?, retry_count = retry_count + 1
        WHERE id = ?`,
      [message, recipientId]
    );
    await appPool().query(
      `UPDATE cert_batches SET failed_count = failed_count + 1 WHERE id = ?`,
      [batchId]
    );
    throw e;
  }
};
