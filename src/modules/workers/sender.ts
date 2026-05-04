import { appPool } from '../../db/pools.js';
import { logger } from '../../common/logger.js';
import {
  deleteJob,
  receiveJobs,
  type EmailJob,
  type ReceivedJob,
} from '../aws/sqs.service.js';
import { sendOne, TransientSesError, type AttachmentData } from '../aws/ses.service.js';
import { downloadFromS3 } from '../aws/s3.service.js';
import { buildVars, render } from '../templates/placeholders.js';
import { TokenBucket } from './rateLimiter.js';
import { env } from '../../config/env.js';

const MAX_RETRIES = 5;

interface RecipientRow {
  id: number;
  campaign_id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  payload_json: any;
  status: string;
  retry_count: number;
}

interface CampaignRow {
  id: number;
  status: string;
  template_id: number;
  from_email: string;
  reply_to: string | null;
  global_vars: any;
}

interface TemplateRow {
  id: number;
  subject: string;
  html_body: string;
  text_body: string | null;
}

interface AttachmentDbRow {
  id: number;
  s3_key: string;
  filename: string;
  content_type: string;
}

// Per-worker attachment cache keyed by template_id — downloaded once and reused.
const attachmentCache = new Map<number, AttachmentData[]>();

async function loadTemplateAttachments(templateId: number): Promise<AttachmentData[]> {
  if (attachmentCache.has(templateId)) return attachmentCache.get(templateId)!;

  const [rows]: any = await appPool().query(
    'SELECT id, s3_key, filename, content_type FROM template_attachments WHERE template_id = ?',
    [templateId]
  );
  const dbRows = rows as AttachmentDbRow[];

  const attachments = await Promise.all(
    dbRows.map(async (r) => {
      try {
        const content = await downloadFromS3(r.s3_key);
        return { filename: r.filename, content, contentType: r.content_type };
      } catch (e) {
        logger.warn({ err: e, s3Key: r.s3_key }, 'Could not download template attachment, skipping');
        return null;
      }
    })
  );

  const valid = attachments.filter((a): a is AttachmentData => a !== null);
  attachmentCache.set(templateId, valid);
  return valid;
}

async function loadJobContext(job: EmailJob) {
  const [recipients]: any = await appPool().query(
    'SELECT * FROM campaign_recipients WHERE id = ? AND campaign_id = ? LIMIT 1',
    [job.recipientId, job.campaignId]
  );
  const recipient = recipients[0] as RecipientRow | undefined;
  if (!recipient) return null;

  const [campaigns]: any = await appPool().query(
    'SELECT id, status, template_id, from_email, reply_to, global_vars FROM campaigns WHERE id = ? LIMIT 1',
    [job.campaignId]
  );
  const campaign = campaigns[0] as CampaignRow | undefined;
  if (!campaign) return null;

  const [templates]: any = await appPool().query(
    'SELECT id, subject, html_body, text_body FROM email_templates WHERE id = ? LIMIT 1',
    [campaign.template_id]
  );
  const template = templates[0] as TemplateRow | undefined;
  if (!template) return null;

  return { recipient, campaign, template };
}

async function isSuppressed(email: string): Promise<boolean> {
  const [rows]: any = await appPool().query(
    'SELECT 1 FROM suppression_list WHERE email = ? LIMIT 1',
    [email]
  );
  return rows.length > 0;
}

async function markSent(recipientId: number, campaignId: number, messageId: string) {
  await appPool().query(
    `UPDATE campaign_recipients SET status='SENT', ses_message_id=?, sent_at=NOW(), error_reason=NULL
       WHERE id=?`,
    [messageId, recipientId]
  );
  await appPool().query('UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?', [campaignId]);
}

async function markFailed(recipientId: number, campaignId: number, reason: string) {
  await appPool().query(
    `UPDATE campaign_recipients SET status='FAILED', error_reason=? WHERE id=?`,
    [reason.slice(0, 1000), recipientId]
  );
  await appPool().query('UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?', [campaignId]);
}

async function markSuppressedAtSend(recipientId: number, campaignId: number) {
  await appPool().query(
    `UPDATE campaign_recipients SET status='SUPPRESSED', error_reason='In suppression list' WHERE id=?`,
    [recipientId]
  );
  await appPool().query(
    'UPDATE campaigns SET suppressed_count = suppressed_count + 1 WHERE id = ?',
    [campaignId]
  );
}

async function bumpRetry(recipientId: number) {
  await appPool().query(
    'UPDATE campaign_recipients SET retry_count = retry_count + 1 WHERE id = ?',
    [recipientId]
  );
}

async function maybeCompleteCampaign(campaignId: number) {
  const [rows]: any = await appPool().query(
    `SELECT
       SUM(status IN ('PENDING','QUEUED')) AS pending,
       COUNT(*) AS total
     FROM campaign_recipients WHERE campaign_id = ?`,
    [campaignId]
  );
  const pending = Number(rows[0]?.pending ?? 0);
  if (pending === 0) {
    await appPool().query(
      `UPDATE campaigns SET status = 'COMPLETED', completed_at = NOW()
        WHERE id = ? AND status IN ('QUEUED','RUNNING')`,
      [campaignId]
    );
  }
}

const limiter = new TokenBucket(env.SES_MAX_SEND_RATE_PER_SEC, env.SES_MAX_SEND_RATE_PER_SEC);

async function processOne(received: ReceivedJob): Promise<void> {
  const { job, receiptHandle } = received;
  const ctx = await loadJobContext(job);
  if (!ctx) {
    await deleteJob(receiptHandle);
    return;
  }
  const { recipient, campaign, template } = ctx;

  if (campaign.status === 'PAUSED') return;
  if (['CANCELLED', 'COMPLETED', 'FAILED'].includes(campaign.status)) {
    await deleteJob(receiptHandle);
    return;
  }

  if (['SENT', 'FAILED', 'BOUNCED', 'COMPLAINT', 'SUPPRESSED', 'DELIVERED'].includes(recipient.status)) {
    await deleteJob(receiptHandle);
    return;
  }

  if (await isSuppressed(recipient.email)) {
    await markSuppressedAtSend(recipient.id, campaign.id);
    await deleteJob(receiptHandle);
    return;
  }

  const globals =
    campaign.global_vars && typeof campaign.global_vars === 'object'
      ? (campaign.global_vars as Record<string, unknown>)
      : {};
  const vars = buildVars(
    {
      email: recipient.email,
      first_name: recipient.first_name,
      last_name: recipient.last_name,
      payload_json: recipient.payload_json,
    },
    globals
  );
  const subject = render(template.subject, vars).output;
  const html = render(template.html_body, vars).output;
  const text = template.text_body ? render(template.text_body, vars).output : null;

  // Load attachments from cache (first call downloads from S3, subsequent calls are instant)
  const attachments = env.AWS_S3_BUCKET
    ? await loadTemplateAttachments(campaign.template_id)
    : [];

  await limiter.take();

  try {
    const out = await sendOne({
      fromEmail: campaign.from_email,
      toEmail: recipient.email,
      subject,
      htmlBody: html,
      textBody: text,
      replyTo: campaign.reply_to ?? null,
      campaignId: campaign.id,
      recipientId: recipient.id,
      attachments: attachments.length ? attachments : undefined,
    });
    await markSent(recipient.id, campaign.id, out.messageId);
    await deleteJob(receiptHandle);
    await maybeCompleteCampaign(campaign.id);
  } catch (e: any) {
    if (e instanceof TransientSesError && recipient.retry_count < MAX_RETRIES) {
      await bumpRetry(recipient.id);
      logger.warn(
        { recipientId: recipient.id, retry: recipient.retry_count + 1, err: e.message },
        'Transient SES error, will retry'
      );
      return;
    }
    const reason = e?.message || String(e);
    await markFailed(recipient.id, campaign.id, reason);
    await deleteJob(receiptHandle);
    await maybeCompleteCampaign(campaign.id);
  }
}

export async function workerLoop(opts: { concurrency: number; signal: AbortSignal }) {
  const { concurrency, signal } = opts;
  const inFlight = new Set<Promise<void>>();
  logger.info({ concurrency }, 'Worker started');

  while (!signal.aborted) {
    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
      continue;
    }
    let received: ReceivedJob[] = [];
    try {
      received = await receiveJobs(env.WORKER_BATCH_SIZE);
    } catch (e) {
      logger.error({ err: e }, 'SQS receive failed');
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (!received.length) continue;

    for (const r of received) {
      const p = processOne(r)
        .catch((e) => logger.error({ err: e, jobId: r.messageId }, 'processOne crashed'))
        .finally(() => inFlight.delete(p));
      inFlight.add(p);
      if (inFlight.size >= concurrency) break;
    }
  }
  await Promise.allSettled([...inFlight]);
  logger.info('Worker stopped');
}
