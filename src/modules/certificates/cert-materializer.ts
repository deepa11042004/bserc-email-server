import { randomBytes } from 'node:crypto';
import { appPool } from '../../db/pools.js';
import { logger } from '../../common/logger.js';
import { downloadFromS3 } from '../aws/s3.service.js';
import { enqueueCertJobs } from './cert-queue.service.js';
import { iterateRows } from './parse-spreadsheet.js';
import type { SerialConfig } from './cert-batches.types.js';

const INSERT_CHUNK = 1000;
const VERIFICATION_CODE_BYTES = 18; // 18 bytes -> 24 base64url chars (matches CHAR(24) column)

const URL_SAFE_ALPHA = /[+/=]/g;
const URL_SAFE_REPLACEMENTS: Record<string, string> = { '+': '-', '/': '_', '=': '' };

export const generateVerificationCode = (): string => {
  return randomBytes(VERIFICATION_CODE_BYTES)
    .toString('base64')
    .replace(URL_SAFE_ALPHA, (c) => URL_SAFE_REPLACEMENTS[c]!);
};

export const formatSerial = (cfg: SerialConfig | null, n: number): string => {
  const prefix = cfg?.prefix ?? '';
  const suffix = cfg?.suffix ?? '';
  const pad = Math.max(0, cfg?.paddingWidth ?? 0);
  const num = pad > 0 ? String(n).padStart(pad, '0') : String(n);
  return `${prefix}${num}${suffix}`;
};

interface BatchSnapshot {
  id: number;
  template_id: number;
  source_filename: string;
  source_content_type: string;
  source_s3_key: string;
  detected_columns_json: string[] | null;
  email_column: string | null;
  name_column: string | null;
  serial_config_json: SerialConfig | null;
  status: string;
}

const loadBatch = async (id: number): Promise<BatchSnapshot> => {
  const [rows]: any = await appPool().query(
    `SELECT id, template_id, source_filename, source_content_type, source_s3_key,
            detected_columns_json, email_column, name_column, serial_config_json, status
       FROM cert_batches WHERE id = ? LIMIT 1`,
    [id]
  );
  const row = rows[0];
  if (!row) throw new Error(`Batch ${id} not found`);
  const parseJson = (v: unknown): any => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(String(v)); } catch { return null; }
  };
  return {
    ...row,
    detected_columns_json: parseJson(row.detected_columns_json),
    serial_config_json: parseJson(row.serial_config_json),
  };
};

const insertChunk = async (
  batchId: number,
  rows: Array<{
    rowIndex: number;
    serialNo: string;
    code: string;
    email: string | null;
    name: string | null;
    rowJson: Record<string, string>;
  }>
): Promise<number[]> => {
  if (!rows.length) return [];
  const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(',');
  const values: unknown[] = [];
  for (const r of rows) {
    values.push(
      batchId,
      r.rowIndex,
      r.serialNo,
      r.code,
      r.email,
      r.name,
      JSON.stringify(r.rowJson)
    );
  }
  const [res]: any = await appPool().query(
    `INSERT INTO cert_recipients
       (batch_id, row_index, serial_no, verification_code, email, full_name, row_data_json)
     VALUES ${placeholders}`,
    values
  );
  // mysql2 returns insertId of the FIRST row; subsequent rows are sequential when auto_increment_increment=1.
  const startId = Number(res.insertId);
  return rows.map((_, i) => startId + i);
};

/**
 * Streams rows from the source spreadsheet in S3, assigns serial + verification
 * code to each, inserts cert_recipients in {@link INSERT_CHUNK}-row batches, and
 * enqueues a render job per row. Designed for batches up to ~1M rows: memory is
 * bounded by INSERT_CHUNK and a single SQS batch (10 jobs). Returns total rows
 * materialized so the caller can update batch counters.
 */
export const materializeBatch = async (batchId: number): Promise<{
  totalRows: number;
  enqueued: number;
}> => {
  const batch = await loadBatch(batchId);
  if (batch.status !== 'READY' && batch.status !== 'RENDERING') {
    throw new Error(`Batch ${batchId} cannot be materialized from status ${batch.status}`);
  }
  if (!batch.detected_columns_json?.length) {
    throw new Error(`Batch ${batchId} has no detected columns`);
  }

  // Transition to RENDERING up-front to lock the batch against concurrent starts.
  await appPool().query(
    `UPDATE cert_batches SET status = 'RENDERING', started_at = COALESCE(started_at, NOW()) WHERE id = ?`,
    [batchId]
  );

  const buf = await downloadFromS3(batch.source_s3_key);
  const serialCfg = batch.serial_config_json;
  let serialN = serialCfg?.startAt ?? 1;
  let rowIndex = 0;
  let totalEnqueued = 0;

  let buffered: Array<{
    rowIndex: number;
    serialNo: string;
    code: string;
    email: string | null;
    name: string | null;
    rowJson: Record<string, string>;
  }> = [];

  const flush = async () => {
    if (!buffered.length) return;
    const ids = await insertChunk(batchId, buffered);
    const jobs = ids.map((rid) => ({ batchId, recipientId: rid }));
    const sent = await enqueueCertJobs(jobs);
    totalEnqueued += sent;
    buffered = [];
  };

  try {
    for await (const row of iterateRows(
      buf,
      batch.source_filename,
      batch.source_content_type,
      batch.detected_columns_json
    )) {
      const email = batch.email_column ? (row[batch.email_column] ?? null) || null : null;
      const name = batch.name_column ? (row[batch.name_column] ?? null) || null : null;
      buffered.push({
        rowIndex: rowIndex++,
        serialNo: formatSerial(serialCfg, serialN++),
        code: generateVerificationCode(),
        email,
        name,
        rowJson: row,
      });
      if (buffered.length >= INSERT_CHUNK) await flush();
    }
    await flush();
  } catch (e) {
    logger.error({ err: e, batchId }, 'Materialization failed');
    await appPool().query(
      `UPDATE cert_batches SET status = 'FAILED' WHERE id = ?`,
      [batchId]
    );
    throw e;
  }

  // Update the canonical row count (in case detected sample differed from real stream length)
  await appPool().query(
    `UPDATE cert_batches SET total_rows = ? WHERE id = ?`,
    [rowIndex, batchId]
  );

  // Update the serial sequence cursor so future re-runs or additions know where we stopped.
  await appPool().query(
    `UPDATE cert_serial_sequences SET current_value = ? WHERE batch_id = ?`,
    [serialN, batchId]
  );

  logger.info({ batchId, totalRows: rowIndex, enqueued: totalEnqueued }, 'Batch materialized');
  return { totalRows: rowIndex, enqueued: totalEnqueued };
};
