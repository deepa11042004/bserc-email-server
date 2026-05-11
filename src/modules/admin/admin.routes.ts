import { Router } from 'express';
import {
  GetQueueAttributesCommand,
  StartMessageMoveTaskCommand,
  ListMessageMoveTasksCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageBatchCommand,
} from '@aws-sdk/client-sqs';
import { asyncHandler } from '../../common/asyncHandler.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import { sqs } from '../aws/clients.js';
import { env } from '../../config/env.js';
import { appPool } from '../../db/pools.js';
import { enqueueJobs } from '../aws/sqs.service.js';
import { notFound } from '../../common/errors.js';

export const adminRouter = Router();
adminRouter.use(requireAuth);

adminRouter.get(
  '/queue-health',
  asyncHandler(async (_req, res) => {
    const out: any = { timestamp: new Date().toISOString() };

    if (!env.SQS_QUEUE_URL) {
      out.queue = { status: 'unconfigured', message: 'SQS_QUEUE_URL is empty' };
    } else {
      try {
        const main = await sqs().send(
          new GetQueueAttributesCommand({
            QueueUrl: env.SQS_QUEUE_URL,
            AttributeNames: [
              'ApproximateNumberOfMessages',
              'ApproximateNumberOfMessagesNotVisible',
              'ApproximateNumberOfMessagesDelayed',
              'CreatedTimestamp',
            ],
          })
        );
        out.queue = {
          name: env.SQS_QUEUE_NAME,
          url: env.SQS_QUEUE_URL,
          visible: Number(main.Attributes?.ApproximateNumberOfMessages ?? 0),
          inFlight: Number(main.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
          delayed: Number(main.Attributes?.ApproximateNumberOfMessagesDelayed ?? 0),
        };
      } catch (e: any) {
        out.queue = { status: 'error', message: e?.message };
      }
    }

    if (env.SQS_DLQ_URL) {
      try {
        const dlq = await sqs().send(
          new GetQueueAttributesCommand({
            QueueUrl: env.SQS_DLQ_URL,
            AttributeNames: ['ApproximateNumberOfMessages'],
          })
        );
        out.dlq = {
          name: env.SQS_DLQ_NAME,
          url: env.SQS_DLQ_URL,
          messages: Number(dlq.Attributes?.ApproximateNumberOfMessages ?? 0),
        };
      } catch (e: any) {
        out.dlq = { status: 'error', message: e?.message };
      }
    } else {
      out.dlq = { status: 'unconfigured' };
    }

    // Worker config snapshot
    out.worker = {
      concurrency: env.WORKER_CONCURRENCY,
      batchSize: env.WORKER_BATCH_SIZE,
      visibilityTimeoutSec: env.WORKER_VISIBILITY_TIMEOUT_SEC,
      sesMaxSendRatePerSec: env.SES_MAX_SEND_RATE_PER_SEC,
    };

    // DB-side counters
    const [pendingRows]: any = await appPool().query(
      `SELECT COUNT(*) AS pending FROM campaign_recipients
        WHERE status IN ('PENDING','QUEUED')`
    );
    const [failedRows]: any = await appPool().query(
      `SELECT COUNT(*) AS failed FROM campaign_recipients WHERE status = 'FAILED'`
    );
    const [activeRows]: any = await appPool().query(
      `SELECT COUNT(*) AS active FROM campaigns WHERE status IN ('QUEUED','RUNNING')`
    );

    out.db = {
      pendingRecipients: Number(pendingRows[0]?.pending ?? 0),
      failedRecipients: Number(failedRows[0]?.failed ?? 0),
      activeCampaigns: Number(activeRows[0]?.active ?? 0),
    };

    // Status verdict
    const visible = out.queue?.visible ?? 0;
    const inFlight = out.queue?.inFlight ?? 0;
    const dlqCount = out.dlq?.messages ?? 0;
    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (dlqCount > 0) status = 'warning';
    if (dlqCount > 50 || visible > 50000) status = 'critical';
    if (out.queue?.status === 'error') status = 'critical';
    out.status = status;

    res.json(out);
  })
);

adminRouter.get(
  '/dashboard-summary',
  asyncHandler(async (_req, res) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [campaigns]: any = await appPool().query(
      `SELECT COUNT(*) AS total,
              SUM(status IN ('QUEUED','RUNNING')) AS active,
              SUM(status = 'COMPLETED') AS completed,
              SUM(status = 'FAILED') AS failed
         FROM campaigns`
    );
    const [today24]: any = await appPool().query(
      `SELECT
         COALESCE(SUM(status IN ('SENT','DELIVERED')), 0) AS sentToday,
         COALESCE(SUM(status = 'FAILED'), 0) AS failedToday,
         COALESCE(SUM(status = 'BOUNCED'), 0) AS bouncedToday
       FROM campaign_recipients
       WHERE sent_at >= ? OR (sent_at IS NULL AND status='FAILED' AND queued_at >= ?)`,
      [today, today]
    );
    const [recent]: any = await appPool().query(
      `SELECT id, campaign_name, status, total_recipients, sent_count, failed_count, created_at
         FROM campaigns ORDER BY id DESC LIMIT 10`
    );
    const [active]: any = await appPool().query(
      `SELECT id, campaign_name, status, total_recipients, sent_count, failed_count, queued_count
         FROM campaigns WHERE status IN ('QUEUED','RUNNING','PAUSED') ORDER BY id DESC LIMIT 10`
    );

    res.json({
      campaigns: {
        total: Number(campaigns[0]?.total ?? 0),
        active: Number(campaigns[0]?.active ?? 0),
        completed: Number(campaigns[0]?.completed ?? 0),
        failed: Number(campaigns[0]?.failed ?? 0),
      },
      today: {
        sent: Number(today24[0]?.sentToday ?? 0),
        failed: Number(today24[0]?.failedToday ?? 0),
        bounced: Number(today24[0]?.bouncedToday ?? 0),
      },
      recent,
      active,
    });
  })
);

adminRouter.get(
  '/failed-emails',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const [rows]: any = await appPool().query(
      `SELECT cr.id, cr.campaign_id, c.campaign_name, cr.email, cr.first_name, cr.last_name,
              cr.status, cr.error_reason, cr.retry_count, cr.queued_at, cr.sent_at
         FROM campaign_recipients cr
         JOIN campaigns c ON c.id = cr.campaign_id
         WHERE cr.status = 'FAILED'
         ORDER BY cr.id DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    const [countRows]: any = await appPool().query(
      `SELECT COUNT(*) AS total FROM campaign_recipients WHERE status='FAILED'`
    );
    res.json({ items: rows, total: Number(countRows[0]?.total ?? 0) });
  })
);

adminRouter.post(
  '/retry/:recipientId',
  requireRole('ADMIN', 'OPERATOR'),
  asyncHandler(async (req, res) => {
    const recipientId = Number(req.params.recipientId);
    const [rows]: any = await appPool().query(
      `SELECT id, campaign_id FROM campaign_recipients WHERE id = ? LIMIT 1`,
      [recipientId]
    );
    const r = rows[0];
    if (!r) throw notFound('Recipient not found');

    await appPool().query(
      `UPDATE campaign_recipients SET status='QUEUED', error_reason=NULL, queued_at=NOW()
        WHERE id = ?`,
      [recipientId]
    );
    await enqueueJobs([{ campaignId: r.campaign_id, recipientId: r.id }]);
    res.json({ recipientId, status: 'QUEUED' });
  })
);

adminRouter.post(
  '/retry-failed/:campaignId',
  requireRole('ADMIN', 'OPERATOR'),
  asyncHandler(async (req, res) => {
    const campaignId = Number(req.params.campaignId);
    const [rows]: any = await appPool().query(
      `SELECT id FROM campaign_recipients WHERE campaign_id = ? AND status='FAILED'`,
      [campaignId]
    );
    if (!rows.length) return res.json({ campaignId, retried: 0 });

    const ids = rows.map((r: any) => r.id as number);
    for (let i = 0; i < ids.length; i += 1000) {
      const part = ids.slice(i, i + 1000);
      await appPool().query(
        `UPDATE campaign_recipients SET status='QUEUED', error_reason=NULL, queued_at=NOW()
          WHERE id IN (${part.map(() => '?').join(',')})`,
        part
      );
    }
    await enqueueJobs(ids.map((id: number) => ({ campaignId, recipientId: id })));
    // Reset failed_count on the campaign
    await appPool().query(
      `UPDATE campaigns SET failed_count = GREATEST(failed_count - ?, 0) WHERE id = ?`,
      [ids.length, campaignId]
    );
    res.json({ campaignId, retried: ids.length });
  })
);

// ---------------------------------------------------------------------------
// DLQ redrive — move all DLQ messages back to the main queue via AWS native
// StartMessageMoveTask. Returns a taskHandle you can poll with GET /redrive-dlq.
// ---------------------------------------------------------------------------
adminRouter.post(
  '/redrive-dlq',
  requireRole('ADMIN'),
  asyncHandler(async (_req, res) => {
    if (!env.SQS_DLQ_URL || !env.SQS_QUEUE_URL) {
      return res.status(503).json({ error: 'SQS_DLQ_URL or SQS_QUEUE_URL not configured' });
    }

    // Fetch ARNs — StartMessageMoveTask requires ARNs not URLs.
    const [dlqAttrs, mainAttrs] = await Promise.all([
      sqs().send(new GetQueueAttributesCommand({ QueueUrl: env.SQS_DLQ_URL, AttributeNames: ['QueueArn'] })),
      sqs().send(new GetQueueAttributesCommand({ QueueUrl: env.SQS_QUEUE_URL, AttributeNames: ['QueueArn'] })),
    ]);
    const dlqArn = dlqAttrs.Attributes?.QueueArn;
    const mainArn = mainAttrs.Attributes?.QueueArn;
    if (!dlqArn || !mainArn) {
      return res.status(500).json({ error: 'Could not resolve queue ARNs' });
    }

    const out = await sqs().send(
      new StartMessageMoveTaskCommand({ SourceArn: dlqArn, DestinationArn: mainArn })
    );
    res.json({ taskHandle: out.TaskHandle, message: 'DLQ redrive started — messages are moving to main queue' });
  })
);

// GET /redrive-dlq — check status of the last redrive task.
adminRouter.get(
  '/redrive-dlq',
  requireRole('ADMIN'),
  asyncHandler(async (_req, res) => {
    if (!env.SQS_DLQ_URL) {
      return res.status(503).json({ error: 'SQS_DLQ_URL not configured' });
    }
    const dlqAttrs = await sqs().send(
      new GetQueueAttributesCommand({ QueueUrl: env.SQS_DLQ_URL, AttributeNames: ['QueueArn'] })
    );
    const dlqArn = dlqAttrs.Attributes?.QueueArn;
    const tasks = await sqs().send(new ListMessageMoveTasksCommand({ SourceArn: dlqArn }));
    res.json({ tasks: tasks.Results ?? [] });
  })
);

// ---------------------------------------------------------------------------
// Re-enqueue stuck QUEUED recipients — for cases where the SQS message was
// lost (e.g. went to DLQ and got dropped) but the DB record is still QUEUED.
// Finds all QUEUED recipients for a campaign and pushes them back into SQS.
// ---------------------------------------------------------------------------
adminRouter.post(
  '/requeue-stuck/:campaignId',
  requireRole('ADMIN', 'OPERATOR'),
  asyncHandler(async (req, res) => {
    const campaignId = Number(req.params.campaignId);
    const [rows]: any = await appPool().query(
      `SELECT id FROM campaign_recipients WHERE campaign_id = ? AND status IN ('QUEUED','PENDING')`,
      [campaignId]
    );
    if (!rows.length) return res.json({ campaignId, requeued: 0 });

    const ids = rows.map((r: any) => r.id as number);

    // Reset retry counter so they get a clean 5 retries.
    for (let i = 0; i < ids.length; i += 1000) {
      const part = ids.slice(i, i + 1000);
      await appPool().query(
        `UPDATE campaign_recipients
            SET status='QUEUED', error_reason=NULL, retry_count=0, queued_at=NOW()
          WHERE id IN (${part.map(() => '?').join(',')})`,
        part
      );
    }

    // Ensure campaign is RUNNING so the worker picks them up.
    await appPool().query(
      `UPDATE campaigns SET status='RUNNING' WHERE id = ? AND status IN ('QUEUED','PAUSED','RUNNING')`,
      [campaignId]
    );

    await enqueueJobs(ids.map((id: number) => ({ campaignId, recipientId: id })));
    res.json({ campaignId, requeued: ids.length });
  })
);
