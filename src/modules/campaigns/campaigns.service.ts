import { appPool } from '../../db/pools.js';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { getTemplate } from '../templates/templates.service.js';
import { enqueueJobs } from '../aws/sqs.service.js';
import {
  fromApi,
  fromQuery,
  fromTable,
  type InboundRecipient,
  materializeRecipients,
} from '../recipients/recipient.builder.js';
import { logger } from '../../common/logger.js';

export type SourceType = 'API' | 'DB_TABLE' | 'SQL_QUERY';

export interface CreateCampaignBase {
  campaignName: string;
  templateId: number;
  fromEmail: string;
  replyTo?: string | null;
  globalVars?: Record<string, unknown>;
}

export type CreateCampaignInput =
  | (CreateCampaignBase & { source: 'API'; recipients: InboundRecipient[] })
  | (CreateCampaignBase & {
      source: 'DB_TABLE';
      tableName: string;
      emailColumn: string;
      firstNameColumn?: string;
      lastNameColumn?: string;
      whereClause?: string;
      limit?: number;
    })
  | (CreateCampaignBase & { source: 'SQL_QUERY'; query: string; limit?: number });

export const createCampaign = async (
  input: CreateCampaignInput,
  userId: number
): Promise<{ campaignId: number; stats: any }> => {
  await getTemplate(input.templateId); // validate exists

  const sourceMeta: Record<string, unknown> = {};
  if (input.source === 'DB_TABLE') {
    sourceMeta.tableName = input.tableName;
    sourceMeta.emailColumn = input.emailColumn;
    sourceMeta.firstNameColumn = input.firstNameColumn;
    sourceMeta.lastNameColumn = input.lastNameColumn;
    sourceMeta.whereClause = input.whereClause;
    sourceMeta.limit = input.limit;
  } else if (input.source === 'SQL_QUERY') {
    sourceMeta.queryPreview = input.query.slice(0, 500);
    sourceMeta.limit = input.limit;
  } else if (input.source === 'API') {
    sourceMeta.providedCount = input.recipients.length;
  }

  const [r]: any = await appPool().query(
    `INSERT INTO campaigns
       (campaign_name, template_id, from_email, reply_to, source_type, source_meta, global_vars, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?)`,
    [
      input.campaignName,
      input.templateId,
      input.fromEmail,
      input.replyTo ?? null,
      input.source,
      JSON.stringify(sourceMeta),
      JSON.stringify(input.globalVars ?? {}),
      userId,
    ]
  );
  const campaignId = r.insertId as number;

  // materialize recipients
  let raw: InboundRecipient[];
  if (input.source === 'API') raw = fromApi(input.recipients);
  else if (input.source === 'DB_TABLE')
    raw = await fromTable({
      tableName: input.tableName,
      emailColumn: input.emailColumn,
      firstNameColumn: input.firstNameColumn,
      lastNameColumn: input.lastNameColumn,
      whereClause: input.whereClause,
      limit: input.limit,
    });
  else raw = await fromQuery(input.query, input.limit);

  const stats = await materializeRecipients(campaignId, raw);

  await appPool().query(
    `UPDATE campaigns SET total_recipients = ?, suppressed_count = ?, status = 'RUNNING', started_at = NOW() WHERE id = ?`,
    [stats.inserted, stats.suppressed, campaignId]
  );

  // enqueue
  const [pending]: any = await appPool().query(
    `SELECT id FROM campaign_recipients WHERE campaign_id = ? AND status = 'PENDING'`,
    [campaignId]
  );
  if (pending.length) {
    const ids = pending.map((p: any) => p.id as number);
    await markQueued(campaignId, ids);
    const sent = await enqueueJobs(ids.map((rid: number) => ({ campaignId, recipientId: rid })));
    logger.info({ campaignId, queued: sent }, 'Enqueued campaign');
  } else {
    await appPool().query(
      `UPDATE campaigns SET status = 'COMPLETED', completed_at = NOW() WHERE id = ?`,
      [campaignId]
    );
  }

  return { campaignId, stats };
};

const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const markQueued = async (campaignId: number, recipientIds: number[]) => {
  for (const part of chunk(recipientIds, 1000)) {
    await appPool().query(
      `UPDATE campaign_recipients SET status = 'QUEUED', queued_at = NOW()
        WHERE id IN (${part.map(() => '?').join(',')})`,
      part
    );
  }
  await appPool().query(
    `UPDATE campaigns SET queued_count = queued_count + ? WHERE id = ?`,
    [recipientIds.length, campaignId]
  );
};

export const getCampaign = async (id: number) => {
  const [rows]: any = await appPool().query('SELECT * FROM campaigns WHERE id = ? LIMIT 1', [id]);
  if (!rows[0]) throw notFound('Campaign not found');
  return rows[0];
};

export const listCampaigns = async (q: { status?: string; limit?: number; offset?: number }) => {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);
  const where: string[] = [];
  const vals: unknown[] = [];
  if (q.status) {
    where.push('status = ?');
    vals.push(q.status);
  }
  vals.push(limit, offset);
  const [rows]: any = await appPool().query(
    `SELECT id, campaign_name, template_id, status, total_recipients, sent_count, failed_count,
            bounced_count, complaint_count, delivered_count, suppressed_count,
            created_at, started_at, completed_at
       FROM campaigns
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT ? OFFSET ?`,
    vals
  );
  return rows;
};

export const getCampaignStats = async (id: number) => {
  const c = await getCampaign(id);
  const [rows]: any = await appPool().query(
    `SELECT status, COUNT(*) AS cnt FROM campaign_recipients WHERE campaign_id = ? GROUP BY status`,
    [id]
  );
  const breakdown: Record<string, number> = {};
  for (const r of rows) breakdown[r.status] = Number(r.cnt);
  return {
    id: c.id,
    name: c.campaign_name,
    status: c.status,
    counters: {
      total: c.total_recipients,
      queued: c.queued_count,
      sent: c.sent_count,
      failed: c.failed_count,
      bounced: c.bounced_count,
      complaints: c.complaint_count,
      delivered: c.delivered_count,
      suppressed: c.suppressed_count,
    },
    recipientStatusBreakdown: breakdown,
    startedAt: c.started_at,
    completedAt: c.completed_at,
  };
};

export const listCampaignRecipients = async (
  campaignId: number,
  q: { status?: string; limit?: number; offset?: number }
) => {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
  const offset = Math.max(q.offset ?? 0, 0);
  const where: string[] = ['campaign_id = ?'];
  const vals: unknown[] = [campaignId];
  if (q.status) {
    where.push('status = ?');
    vals.push(q.status);
  }
  vals.push(limit, offset);
  const [rows]: any = await appPool().query(
    `SELECT id, email, first_name, last_name, status, ses_message_id, error_reason, retry_count,
            queued_at, sent_at, delivered_at
       FROM campaign_recipients
       WHERE ${where.join(' AND ')}
       ORDER BY id ASC LIMIT ? OFFSET ?`,
    vals
  );
  return rows;
};

export const setStatus = async (id: number, status: 'PAUSED' | 'RUNNING' | 'CANCELLED') => {
  const c = await getCampaign(id);
  const allowedTransitions: Record<string, string[]> = {
    QUEUED: ['PAUSED', 'CANCELLED'],
    RUNNING: ['PAUSED', 'CANCELLED'],
    PAUSED: ['RUNNING', 'CANCELLED'],
  };
  const allowed = allowedTransitions[c.status] || [];
  if (!allowed.includes(status)) {
    throw conflict(`Cannot transition campaign from ${c.status} to ${status}`);
  }
  await appPool().query('UPDATE campaigns SET status = ? WHERE id = ?', [status, id]);
  return getCampaign(id);
};

export const isCampaignActive = async (id: number): Promise<boolean> => {
  const [rows]: any = await appPool().query('SELECT status FROM campaigns WHERE id = ? LIMIT 1', [id]);
  const s = rows[0]?.status;
  return s === 'QUEUED' || s === 'RUNNING';
};
