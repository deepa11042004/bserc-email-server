import { appPool } from '../../db/pools.js';
import { env } from '../../config/env.js';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { logger } from '../../common/logger.js';
import { createCampaign } from '../campaigns/campaigns.service.js';
import { getTemplate } from '../templates/templates.service.js';
import { isValidEmail } from '../../common/validate.js';
import type { InboundRecipient } from '../recipients/recipient.builder.js';

export interface DistributeInput {
  emailTemplateId: number;
  fromEmail: string;
  replyTo?: string | null;
  campaignName?: string;
}

interface CertRecipientForEmail {
  id: number;
  email: string;
  full_name: string | null;
  serial_no: string;
  verification_code: string;
  row_data_json: string | Record<string, unknown>;
}

const splitName = (full: string | null): { first: string; last: string } => {
  if (!full) return { first: '', last: '' };
  const trimmed = full.trim();
  if (!trimmed) return { first: '', last: '' };
  const idx = trimmed.indexOf(' ');
  if (idx === -1) return { first: trimmed, last: '' };
  return { first: trimmed.slice(0, idx), last: trimmed.slice(idx + 1).trim() };
};

const parseRowData = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  try { return JSON.parse(String(v ?? '{}')); } catch { return {}; }
};

const verifyUrl = (code: string): string =>
  `${env.CERT_VERIFY_BASE_URL.replace(/\/$/, '')}/${code}`;

/**
 * Build an InboundRecipient for each cert_recipient that's been successfully rendered
 * and has a valid email. Each recipient's `data` carries the certificate-specific vars
 * the email template can reference: {{certificate_url}}, {{verification_url}},
 * {{certificate_id}}, {{recipient_name}}, plus any original spreadsheet columns.
 */
const buildRecipients = async (batchId: number): Promise<InboundRecipient[]> => {
  const [rows]: any = await appPool().query(
    `SELECT id, email, full_name, serial_no, verification_code, row_data_json
       FROM cert_recipients
      WHERE batch_id = ?
        AND status IN ('RENDERED','SENT','DOWNLOADED')
        AND email IS NOT NULL AND email <> ''`,
    [batchId]
  );

  const recipients: InboundRecipient[] = [];
  for (const r of rows as CertRecipientForEmail[]) {
    if (!isValidEmail(r.email)) continue;
    const url = verifyUrl(r.verification_code);
    const original = parseRowData(r.row_data_json);
    const { first, last } = splitName(r.full_name);
    recipients.push({
      email: r.email,
      firstName: first || null,
      lastName: last || null,
      data: {
        ...original,
        certificate_url: url,
        verification_url: url,
        certificate_id: r.serial_no,
        recipient_name: r.full_name ?? '',
      },
    });
  }
  return recipients;
};

export const distributeBatch = async (
  batchId: number,
  input: DistributeInput,
  userId: number
) => {
  // Verify batch is in a distributable state
  const [batchRows]: any = await appPool().query(
    `SELECT id, name, status, total_rows, rendered_count, failed_count, email_campaign_id
       FROM cert_batches WHERE id = ? LIMIT 1`,
    [batchId]
  );
  const batch = batchRows[0];
  if (!batch) throw notFound('Certificate batch not found');
  if (batch.status !== 'RENDERED' && batch.status !== 'DISTRIBUTING') {
    throw conflict(
      `Batch must be in RENDERED state to distribute (currently ${batch.status})`
    );
  }
  if (batch.email_campaign_id) {
    throw conflict(
      `Batch already has an email campaign (id ${batch.email_campaign_id}). Cancel it first to re-distribute.`
    );
  }

  // Verify email template exists
  await getTemplate(input.emailTemplateId, false);

  const recipients = await buildRecipients(batchId);
  if (!recipients.length) {
    throw badRequest('No rendered recipients with valid emails to distribute');
  }

  const campaignName = input.campaignName || `Certificate Distribution: ${batch.name}`;
  const { campaignId } = await createCampaign(
    {
      campaignName,
      templateId: input.emailTemplateId,
      fromEmail: input.fromEmail,
      replyTo: input.replyTo ?? null,
      globalVars: {
        cert_batch_name: batch.name,
      },
      source: 'API',
      recipients,
    },
    userId
  );

  // Link campaign to the cert batch and transition status
  await appPool().query(
    `UPDATE cert_batches SET email_campaign_id = ?, status = 'DISTRIBUTING' WHERE id = ?`,
    [campaignId, batchId]
  );

  // Mark recipients as SENT (the email queue takes over from here)
  const [updateRes]: any = await appPool().query(
    `UPDATE cert_recipients
        SET status = 'SENT', sent_at = NOW()
      WHERE batch_id = ?
        AND status = 'RENDERED'
        AND email IS NOT NULL AND email <> ''`,
    [batchId]
  );
  await appPool().query(
    `UPDATE cert_batches SET sent_count = sent_count + ? WHERE id = ?`,
    [updateRes.affectedRows, batchId]
  );

  logger.info(
    { batchId, campaignId, recipients: recipients.length },
    'Cert batch distributed via email campaign'
  );

  return {
    batchId,
    campaignId,
    queuedRecipients: recipients.length,
  };
};
