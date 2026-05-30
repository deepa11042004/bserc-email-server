import { randomUUID } from 'node:crypto';
import { appPool } from '../../db/pools.js';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { env } from '../../config/env.js';
import {
  uploadToS3,
  deleteFromS3,
  getPresignedDownloadUrl,
} from '../aws/s3.service.js';
import { logger } from '../../common/logger.js';
import { parseSpreadsheet } from './parse-spreadsheet.js';
import { getCertTemplate, listPlaceholders } from './cert-templates.service.js';
import { materializeBatch } from './cert-materializer.js';
import { certS3KeyFor, renderRecipientPdf } from './cert-render-job.js';
import type {
  CertBatchRow,
  CertBatchStatus,
  CertBatchWithUrls,
  CreateBatchInput,
  SaveMappingInput,
  SerialConfig,
} from './cert-batches.types.js';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

const sourceKeyFor = (batchId: number, filename: string): string => {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  return `cert-batches/${batchId}/source/${randomUUID()}-${safe}`;
};

const parseJsonColumn = <T>(raw: unknown): T | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw as T;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as T; } catch { return null; }
  }
  return null;
};

const hydrateRow = async (raw: any): Promise<CertBatchWithUrls> => ({
  ...raw,
  detected_columns_json: parseJsonColumn<string[]>(raw.detected_columns_json),
  sample_rows_json: parseJsonColumn<Record<string, string>[]>(raw.sample_rows_json),
  column_mapping_json: parseJsonColumn<Record<string, string>>(raw.column_mapping_json),
  serial_config_json: parseJsonColumn<SerialConfig>(raw.serial_config_json),
  source_url: env.AWS_S3_BUCKET ? await getPresignedDownloadUrl(raw.source_s3_key) : '',
});

export const createBatch = async (
  input: CreateBatchInput,
  userId: number
): Promise<CertBatchWithUrls> => {
  // Verify template exists + has at least one placeholder defined.
  const tpl = await getCertTemplate(input.templateId, true);
  if (!tpl.placeholders || tpl.placeholders.length === 0) {
    throw badRequest('Template has no placeholders defined yet. Configure placeholders before creating a batch.');
  }

  const buf = Buffer.from(input.file.data, 'base64');
  if (buf.byteLength === 0) throw badRequest('Empty file payload');
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    throw badRequest(`File exceeds max size of ${MAX_UPLOAD_BYTES} bytes`);
  }

  // Parse first so we fail fast on malformed inputs without creating a row or uploading.
  const parsed = await parseSpreadsheet(buf, input.file.filename, input.file.contentType);
  if (parsed.rowCount === 0) throw badRequest('Spreadsheet has no data rows');

  const conn = await appPool().getConnection();
  try {
    await conn.beginTransaction();
    const [r]: any = await conn.query(
      `INSERT INTO cert_batches
         (name, template_id, status, source_filename, source_content_type, source_s3_key,
          source_size_bytes, detected_columns_json, sample_rows_json, total_rows, created_by)
       VALUES (?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        input.templateId,
        input.file.filename,
        input.file.contentType,
        '', // s3 key updated after upload
        buf.byteLength,
        JSON.stringify(parsed.columns),
        JSON.stringify(parsed.sampleRows),
        parsed.rowCount,
        userId,
      ]
    );
    const id = r.insertId as number;
    const key = sourceKeyFor(id, input.file.filename);
    await uploadToS3(key, buf, input.file.contentType);
    await conn.query('UPDATE cert_batches SET source_s3_key = ? WHERE id = ?', [key, id]);
    await conn.commit();
    return getBatch(id);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
};

export const getBatch = async (id: number): Promise<CertBatchWithUrls> => {
  const [rows]: any = await appPool().query(
    'SELECT * FROM cert_batches WHERE id = ? LIMIT 1',
    [id]
  );
  const row = rows[0] as CertBatchRow | undefined;
  if (!row) throw notFound('Certificate batch not found');
  return hydrateRow(row);
};

export const listBatches = async (q: {
  status?: string;
  templateId?: number;
  limit?: number;
  offset?: number;
}): Promise<CertBatchWithUrls[]> => {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);
  const where: string[] = [];
  const vals: unknown[] = [];
  if (q.status) {
    where.push('status = ?');
    vals.push(q.status);
  }
  if (q.templateId) {
    where.push('template_id = ?');
    vals.push(q.templateId);
  }
  vals.push(limit, offset);
  const [rows]: any = await appPool().query(
    `SELECT id, name, template_id, status, source_filename, source_content_type, source_s3_key,
            source_size_bytes, total_rows, rendered_count, failed_count, sent_count,
            email_campaign_id, created_by, created_at, updated_at, started_at, completed_at
       FROM cert_batches
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT ? OFFSET ?`,
    vals
  );
  return Promise.all((rows as any[]).map(hydrateRow));
};

export const deleteBatch = async (id: number): Promise<void> => {
  const [rows]: any = await appPool().query(
    'SELECT source_s3_key, status FROM cert_batches WHERE id = ? LIMIT 1',
    [id]
  );
  const row = rows[0] as { source_s3_key: string; status: CertBatchStatus } | undefined;
  if (!row) throw notFound('Certificate batch not found');
  if (row.status === 'RENDERING' || row.status === 'DISTRIBUTING') {
    throw conflict(`Cannot delete batch in ${row.status} state. Cancel it first.`);
  }
  if (row.source_s3_key) {
    try { await deleteFromS3(row.source_s3_key); } catch { /* best-effort */ }
  }
  // cert_recipients are cascaded by FK; rendered cert objects in S3 are cleaned in Slice 3+
  await appPool().query('DELETE FROM cert_batches WHERE id = ?', [id]);
};

const validateMapping = async (
  templateId: number,
  detectedColumns: string[],
  input: SaveMappingInput
): Promise<void> => {
  const placeholders = await listPlaceholders(templateId);
  // Required placeholders are those NOT auto-generated (i.e., not is_qr, not is_serial).
  const required = placeholders.filter((p) => !p.is_qr && !p.is_serial).map((p) => p.placeholder_key);
  const detected = new Set(detectedColumns);
  const mapping = input.columnMapping || {};

  for (const key of required) {
    const col = mapping[key];
    if (!col) throw badRequest(`Missing mapping for required placeholder "${key}"`);
    if (!detected.has(col)) {
      throw badRequest(`Mapping for "${key}" references unknown column "${col}"`);
    }
  }
  // Reject mappings that reference unknown placeholders
  const placeholderKeys = new Set(placeholders.map((p) => p.placeholder_key));
  for (const key of Object.keys(mapping)) {
    if (!placeholderKeys.has(key)) {
      throw badRequest(`Mapping references unknown placeholder "${key}"`);
    }
    const p = placeholders.find((x) => x.placeholder_key === key)!;
    if (p.is_serial) {
      throw badRequest(`Placeholder "${key}" is auto-generated (serial); do not map a column to it`);
    }
    if (p.is_qr) {
      throw badRequest(`Placeholder "${key}" is auto-generated (QR); do not map a column to it`);
    }
  }
  if (input.emailColumn && !detected.has(input.emailColumn)) {
    throw badRequest(`Email column "${input.emailColumn}" is not one of the detected columns`);
  }
  if (input.nameColumn && !detected.has(input.nameColumn)) {
    throw badRequest(`Name column "${input.nameColumn}" is not one of the detected columns`);
  }
};

const sanitizeSerial = (s: SerialConfig | undefined): SerialConfig => {
  const cfg: SerialConfig = {
    prefix: (s?.prefix ?? '').slice(0, 32),
    suffix: (s?.suffix ?? '').slice(0, 32),
    paddingWidth: Math.min(Math.max(s?.paddingWidth ?? 4, 0), 12),
    startAt: Math.max(s?.startAt ?? 1, 1),
  };
  return cfg;
};

export const saveMapping = async (
  id: number,
  input: SaveMappingInput
): Promise<CertBatchWithUrls> => {
  const batch = await getBatch(id);
  if (batch.status !== 'DRAFT' && batch.status !== 'READY') {
    throw conflict(`Cannot edit mapping in ${batch.status} state`);
  }
  const columns = batch.detected_columns_json ?? [];
  await validateMapping(batch.template_id, columns, input);
  const serial = sanitizeSerial(input.serialConfig);

  const conn = await appPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE cert_batches
          SET column_mapping_json = ?, serial_config_json = ?,
              email_column = ?, name_column = ?, status = 'READY'
        WHERE id = ?`,
      [
        JSON.stringify(input.columnMapping),
        JSON.stringify(serial),
        input.emailColumn ?? null,
        input.nameColumn ?? null,
        id,
      ]
    );
    // Upsert into cert_serial_sequences so the renderer (Slice 3) has its config.
    await conn.query(
      `INSERT INTO cert_serial_sequences (batch_id, prefix, suffix, padding_width, start_at, current_value)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE prefix = VALUES(prefix), suffix = VALUES(suffix),
         padding_width = VALUES(padding_width), start_at = VALUES(start_at),
         current_value = VALUES(start_at)`,
      [id, serial.prefix ?? '', serial.suffix ?? '', serial.paddingWidth ?? 4, serial.startAt ?? 1, serial.startAt ?? 1]
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return getBatch(id);
};

export const getColumnsAndSample = async (id: number) => {
  const b = await getBatch(id);
  return {
    columns: b.detected_columns_json ?? [],
    sampleRows: b.sample_rows_json ?? [],
    totalRows: b.total_rows,
  };
};

/**
 * Start the batch: kick off recipient materialization + render-job enqueue in the
 * background. Returns immediately (caller gets 202). Status moves READY -> RENDERING.
 * Polling cert_batches.status reflects progress.
 */
export const startBatch = async (id: number): Promise<CertBatchWithUrls> => {
  const batch = await getBatch(id);
  if (batch.status === 'RENDERING' || batch.status === 'RENDERED' || batch.status === 'DISTRIBUTING' || batch.status === 'COMPLETED') {
    throw conflict(`Batch already in ${batch.status} state`);
  }
  if (batch.status !== 'READY') {
    throw conflict(`Cannot start batch in ${batch.status} state. Save a mapping first.`);
  }
  if (!batch.column_mapping_json) {
    throw badRequest('Column mapping is not set');
  }
  // Synchronously transition to RENDERING so the next call sees the lock,
  // then run materialization without awaiting.
  await appPool().query(
    `UPDATE cert_batches SET status = 'RENDERING', started_at = NOW() WHERE id = ?`,
    [id]
  );
  // Fire-and-forget background processing. Errors flip batch to FAILED (handled inside materializeBatch).
  void materializeBatch(id).catch((e) => {
    logger.error({ err: e, batchId: id }, 'Background materialization failed');
  });
  return getBatch(id);
};

/**
 * Build a single sample certificate PDF using the spreadsheet row at the given index.
 * Uses a placeholder serial + verification code so previews work before materialization.
 * Upload to a non-canonical "preview" key so the real cert objects aren't clobbered.
 */
export const previewBatch = async (
  id: number,
  rowIndex: number
): Promise<{ url: string; s3Key: string }> => {
  const batch = await getBatch(id);
  if (!batch.column_mapping_json) {
    throw badRequest('Column mapping is not set yet');
  }
  const sampleRows = batch.sample_rows_json ?? [];
  if (rowIndex < 0 || rowIndex >= sampleRows.length) {
    throw badRequest(`Row index ${rowIndex} is outside the sample range (0..${sampleRows.length - 1})`);
  }
  const rowData = sampleRows[rowIndex]!;

  const tpl = await getCertTemplate(batch.template_id, true);
  const placeholders = tpl.placeholders ?? [];

  // Synthesize a sample serial + code for preview only
  const fakeSerial = `${(batch.serial_config_json?.prefix ?? '')}PREVIEW${(batch.serial_config_json?.suffix ?? '')}`;
  const fakeCode = `preview-${randomUUID().slice(0, 16)}`;
  const verificationUrl = `${env.CERT_VERIFY_BASE_URL.replace(/\/$/, '')}/${fakeCode}`;

  const { downloadFromS3 } = await import('../aws/s3.service.js');
  const imageBytes = await downloadFromS3(tpl.image_s3_key);

  const { renderCertificatePdf } = await import('./cert-renderer.js');
  const values: Record<string, string> = { verification_url: verificationUrl };
  const mapping = batch.column_mapping_json ?? {};
  for (const p of placeholders) {
    if (p.is_qr) continue;
    if (p.is_serial) { values[p.placeholder_key] = fakeSerial; continue; }
    const col = mapping[p.placeholder_key];
    if (col) values[p.placeholder_key] = String(rowData[col] ?? '');
  }

  const pdf = await renderCertificatePdf({
    templateImage: {
      bytes: imageBytes,
      contentType: tpl.image_content_type,
      width: tpl.image_width,
      height: tpl.image_height,
    },
    placeholders,
    values,
    verificationUrl,
  });

  const key = `cert-batches/${id}/previews/${randomUUID()}.pdf`;
  await uploadToS3(key, pdf, 'application/pdf');
  return {
    url: env.AWS_S3_BUCKET ? await getPresignedDownloadUrl(key) : '',
    s3Key: key,
  };
};

export const listBatchRecipients = async (
  batchId: number,
  q: { status?: string; limit?: number; offset?: number }
) => {
  await getBatch(batchId); // ensure exists
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
  const offset = Math.max(q.offset ?? 0, 0);
  const where: string[] = ['batch_id = ?'];
  const vals: unknown[] = [batchId];
  if (q.status) { where.push('status = ?'); vals.push(q.status); }
  vals.push(limit, offset);
  const [rows]: any = await appPool().query(
    `SELECT id, row_index, serial_no, verification_code, email, full_name, status,
            cert_s3_key, error_reason, retry_count,
            rendered_at, sent_at, delivered_at, downloaded_at, download_count
       FROM cert_recipients
       WHERE ${where.join(' AND ')}
       ORDER BY row_index ASC, id ASC LIMIT ? OFFSET ?`,
    vals
  );
  // Add presigned URLs for rendered ones
  return Promise.all(rows.map(async (r: any) => ({
    ...r,
    cert_url: r.cert_s3_key && env.AWS_S3_BUCKET ? await getPresignedDownloadUrl(r.cert_s3_key) : '',
  })));
};

/**
 * Re-enqueue a single failed recipient. Resets status to PENDING so the worker picks it up.
 */
export const retryRecipient = async (batchId: number, recipientId: number): Promise<void> => {
  const { enqueueCertJobs } = await import('./cert-queue.service.js');
  const [rows]: any = await appPool().query(
    `SELECT id, status FROM cert_recipients WHERE id = ? AND batch_id = ? LIMIT 1`,
    [recipientId, batchId]
  );
  const row = rows[0];
  if (!row) throw notFound('Recipient not found');
  if (row.status !== 'FAILED' && row.status !== 'PENDING') {
    throw conflict(`Cannot retry recipient in ${row.status} state`);
  }
  await appPool().query(
    `UPDATE cert_recipients SET status = 'PENDING', error_reason = NULL WHERE id = ?`,
    [recipientId]
  );
  await enqueueCertJobs([{ batchId, recipientId }]);
};

export const cancelBatch = async (id: number): Promise<CertBatchWithUrls> => {
  const batch = await getBatch(id);
  if (batch.status === 'COMPLETED' || batch.status === 'CANCELLED') {
    throw conflict(`Batch already in ${batch.status} state`);
  }
  await appPool().query(
    `UPDATE cert_batches SET status = 'CANCELLED' WHERE id = ?`,
    [id]
  );
  return getBatch(id);
};

void certS3KeyFor; // exported for use by Slice 4 (verification) — keep import alive
