import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler.js';
import { validateBody } from '../../common/validate.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import {
  createCampaign,
  getCampaign,
  getCampaignStats,
  listCampaignRecipients,
  listCampaigns,
  setStatus,
} from './campaigns.service.js';
import { sendOne } from '../aws/ses.service.js';
import { getTemplate } from '../templates/templates.service.js';
import { buildVars, render } from '../templates/placeholders.js';

export const campaignsRouter = Router();
campaignsRouter.use(requireAuth);

const RecipientSchema = z.object({
  email: z.string().min(1),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  data: z.record(z.unknown()).optional(),
});

const Base = z.object({
  campaignName: z.string().min(1).max(255),
  templateId: z.number().int().positive(),
  fromEmail: z.string().email(),
  replyTo: z.string().email().nullish(),
  globalVars: z.record(z.unknown()).optional(),
});

const ApiSendSchema = Base.extend({
  recipients: z.array(RecipientSchema).min(1).max(100000),
});

const DbSendSchema = Base.extend({
  tableName: z.string().min(1),
  emailColumn: z.string().min(1),
  firstNameColumn: z.string().optional(),
  lastNameColumn: z.string().optional(),
  whereClause: z.string().optional(),
  limit: z.number().int().positive().max(500000).optional(),
});

const QuerySendSchema = Base.extend({
  query: z.string().min(10),
  limit: z.number().int().positive().max(500000).optional(),
});

campaignsRouter.post(
  '/send',
  requireRole('ADMIN', 'OPERATOR'),
  validateBody(ApiSendSchema),
  asyncHandler(async (req, res) => {
    const out = await createCampaign({ ...req.body, source: 'API' }, req.user!.id);
    res.status(202).json(out);
  })
);

campaignsRouter.post(
  '/send-from-db',
  requireRole('ADMIN', 'OPERATOR'),
  validateBody(DbSendSchema),
  asyncHandler(async (req, res) => {
    const out = await createCampaign({ ...req.body, source: 'DB_TABLE' }, req.user!.id);
    res.status(202).json(out);
  })
);

campaignsRouter.post(
  '/send-from-query',
  requireRole('ADMIN'),
  validateBody(QuerySendSchema),
  asyncHandler(async (req, res) => {
    const out = await createCampaign({ ...req.body, source: 'SQL_QUERY' }, req.user!.id);
    res.status(202).json(out);
  })
);

campaignsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await listCampaigns({
      status: req.query.status as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    res.json(rows);
  })
);

campaignsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => res.json(await getCampaign(Number(req.params.id))))
);

campaignsRouter.get(
  '/:id/stats',
  asyncHandler(async (req, res) => res.json(await getCampaignStats(Number(req.params.id))))
);

campaignsRouter.get(
  '/:id/recipients',
  asyncHandler(async (req, res) => {
    const rows = await listCampaignRecipients(Number(req.params.id), {
      status: req.query.status as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    res.json(rows);
  })
);

campaignsRouter.post(
  '/:id/pause',
  requireRole('ADMIN', 'OPERATOR'),
  asyncHandler(async (req, res) => res.json(await setStatus(Number(req.params.id), 'PAUSED')))
);
campaignsRouter.post(
  '/:id/resume',
  requireRole('ADMIN', 'OPERATOR'),
  asyncHandler(async (req, res) => res.json(await setStatus(Number(req.params.id), 'RUNNING')))
);
campaignsRouter.post(
  '/:id/cancel',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => res.json(await setStatus(Number(req.params.id), 'CANCELLED')))
);

const TestSendSchema = z.object({
  templateId: z.number().int().positive(),
  fromEmail: z.string().email(),
  toEmail: z.string().email(),
  vars: z.record(z.unknown()).default({}),
});
campaignsRouter.post(
  '/test-send',
  requireRole('ADMIN', 'OPERATOR'),
  validateBody(TestSendSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof TestSendSchema>;
    const t = await getTemplate(body.templateId);
    const vars = buildVars(
      { email: body.toEmail, first_name: 'Test', last_name: 'User', payload_json: body.vars },
      body.vars as Record<string, unknown>
    );
    const subject = render(t.subject, vars).output;
    const html = render(t.html_body, vars).output;
    const text = t.text_body ? render(t.text_body, vars).output : null;
    const out = await sendOne({
      fromEmail: body.fromEmail,
      toEmail: body.toEmail,
      subject,
      htmlBody: html,
      textBody: text,
      campaignId: 0,
      recipientId: 0,
    });
    res.json({ messageId: out.messageId, subject });
  })
);
