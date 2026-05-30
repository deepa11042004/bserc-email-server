import { appPool } from '../../db/pools.js';
import { env } from '../../config/env.js';
import { getPresignedDownloadUrl } from '../aws/s3.service.js';

export interface VerifyResult {
  valid: boolean;
  certificate?: {
    recipient_name: string | null;
    serial_no: string;
    batch_name: string;
    template_name: string;
    issued_at: Date | null;
    certificate_url: string;
    verification_count: number;
  };
}

const VERIFY_CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Public lookup by verification_code. Does NOT leak unrelated information on miss —
 * a code that doesn't exist and a code that's pending render both yield the same
 * "not found" response. Records the lookup against the recipient for audit.
 */
export const verifyCertificate = async (
  rawCode: string,
  clientIp: string | null
): Promise<VerifyResult> => {
  if (!rawCode || !VERIFY_CODE_RE.test(rawCode)) {
    return { valid: false };
  }
  const [rows]: any = await appPool().query(
    `SELECT r.id, r.full_name, r.serial_no, r.status, r.cert_s3_key, r.rendered_at,
            r.verification_count,
            b.name AS batch_name,
            t.name AS template_name
       FROM cert_recipients r
       JOIN cert_batches b ON b.id = r.batch_id
       JOIN cert_templates t ON t.id = b.template_id
      WHERE r.verification_code = ? LIMIT 1`,
    [rawCode]
  );
  const row = rows[0];
  if (!row) return { valid: false };
  // Only certificates that have been rendered (and therefore have a real PDF) count as verifiable.
  if (row.status !== 'RENDERED' && row.status !== 'SENT' && row.status !== 'DOWNLOADED') {
    return { valid: false };
  }
  if (!row.cert_s3_key) return { valid: false };

  // Record the verification hit (fire-and-forget to keep the public response fast).
  void appPool().query(
    `UPDATE cert_recipients
        SET verification_count = verification_count + 1,
            last_verified_at = NOW(),
            last_verified_ip = ?
      WHERE id = ?`,
    [clientIp ? clientIp.slice(0, 64) : null, row.id]
  );

  const url = env.AWS_S3_BUCKET ? await getPresignedDownloadUrl(row.cert_s3_key) : '';

  return {
    valid: true,
    certificate: {
      recipient_name: row.full_name,
      serial_no: row.serial_no,
      batch_name: row.batch_name,
      template_name: row.template_name,
      issued_at: row.rendered_at,
      certificate_url: url,
      // include the *previous* count, so the just-recorded hit isn't reflected
      // (a viewer learning "you are the 1st viewer" is a tiny information leak).
      verification_count: Number(row.verification_count ?? 0),
    },
  };
};
