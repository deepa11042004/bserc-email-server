import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler.js';
import { validateBody } from '../../common/validate.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import {
  cancelBatch,
  createBatch,
  deleteBatch,
  getBatch,
  getColumnsAndSample,
  listBatches,
  listBatchRecipients,
  previewBatch,
  retryRecipient,
  saveMapping,
  startBatch,
} from './cert-batches.service.js';
import { distributeBatch } from './cert-distribute.service.js';

export const certBatchesRouter = Router();
certBatchesRouter.use(requireAuth);

const FileBody = z.object({
  filename: z.string().min(1).max(500),
  contentType: z.string().min(1).max(255),
  data: z.string().min(1), // base64
});

const CreateBody = z.object({
  name: z.string().min(1).max(255),
  templateId: z.number().int().positive(),
  file: FileBody,
});

const SerialConfigSchema = z.object({
  prefix: z.string().max(32).optional(),
  suffix: z.string().max(32).optional(),
  paddingWidth: z.number().int().min(0).max(12).optional(),
  startAt: z.number().int().min(1).max(1_000_000_000).optional(),
});

const MappingBody = z.object({
  columnMapping: z.record(z.string().min(1).max(255)),
  serialConfig: SerialConfigSchema.optional(),
  emailColumn: z.string().max(255).nullish(),
  nameColumn: z.string().max(255).nullish(),
});

certBatchesRouter.post(
  '/',
  requireRole('ADMIN', 'OPERATOR'),
  validateBody(CreateBody),
  asyncHandler(async (req, res) => {
    const b = await createBatch(req.body, req.user!.id);
    res.status(201).json(b);
  })
);

certBatchesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await listBatches({
      status: req.query.status as string | undefined,
      templateId: req.query.templateId ? Number(req.query.templateId) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    res.json(rows);
  })
);

certBatchesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await getBatch(Number(req.params.id)));
  })
);

certBatchesRouter.get(
  '/:id/columns',
  asyncHandler(async (req, res) => {
    res.json(await getColumnsAndSample(Number(req.params.id)));
  })
);

certBatchesRouter.put(
  '/:id/mapping',
  requireRole('ADMIN', 'OPERATOR'),
  validateBody(MappingBody),
  asyncHandler(async (req, res) => {
    const b = await saveMapping(Number(req.params.id), req.body);
    res.json(b);
  })
);

certBatchesRouter.delete(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    await deleteBatch(Number(req.params.id));
    res.status(204).end();
  })
);

certBatchesRouter.post(
  '/:id/start',
  requireRole('ADMIN', 'OPERATOR'),
  asyncHandler(async (req, res) => {
    const b = await startBatch(Number(req.params.id));
    res.status(202).json(b);
  })
);

certBatchesRouter.post(
  '/:id/cancel',
  requireRole('ADMIN', 'OPERATOR'),
  asyncHandler(async (req, res) => {
    res.json(await cancelBatch(Number(req.params.id)));
  })
);

certBatchesRouter.get(
  '/:id/preview',
  asyncHandler(async (req, res) => {
    const rowIndex = req.query.row ? Number(req.query.row) : 0;
    const out = await previewBatch(Number(req.params.id), rowIndex);
    res.json(out);
  })
);

certBatchesRouter.get(
  '/:id/recipients',
  asyncHandler(async (req, res) => {
    const rows = await listBatchRecipients(Number(req.params.id), {
      status: req.query.status as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    res.json(rows);
  })
);

certBatchesRouter.post(
  '/:id/recipients/:recipientId/retry',
  requireRole('ADMIN', 'OPERATOR'),
  asyncHandler(async (req, res) => {
    await retryRecipient(Number(req.params.id), Number(req.params.recipientId));
    res.status(202).json({ status: 'queued' });
  })
);

const DistributeBody = z.object({
  emailTemplateId: z.number().int().positive(),
  fromEmail: z.string().email(),
  replyTo: z.string().email().nullish(),
  campaignName: z.string().min(1).max(255).optional(),
});

certBatchesRouter.post(
  '/:id/distribute',
  requireRole('ADMIN', 'OPERATOR'),
  validateBody(DistributeBody),
  asyncHandler(async (req, res) => {
    const result = await distributeBatch(Number(req.params.id), req.body, req.user!.id);
    res.status(202).json(result);
  })
);
