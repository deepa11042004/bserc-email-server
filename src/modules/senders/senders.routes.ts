import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler.js';
import { validateBody } from '../../common/validate.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import {
  createSender,
  deleteSender,
  listSenders,
  updateSender,
} from './senders.service.js';

export const sendersRouter = Router();
sendersRouter.use(requireAuth);

const SenderBody = z.object({
  displayName: z.string().min(1).max(255),
  email: z.string().email(),
  replyTo: z.string().email().nullish(),
  isDefault: z.boolean().optional(),
});

sendersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const activeOnly = req.query.active === 'true';
    res.json(await listSenders(activeOnly));
  })
);

sendersRouter.post(
  '/',
  requireRole('ADMIN', 'OPERATOR'),
  validateBody(SenderBody),
  asyncHandler(async (req, res) => {
    res.status(201).json(await createSender(req.body));
  })
);

const SenderPatch = SenderBody.partial().extend({
  isActive: z.boolean().optional(),
});

sendersRouter.put(
  '/:id',
  requireRole('ADMIN', 'OPERATOR'),
  validateBody(SenderPatch),
  asyncHandler(async (req, res) => {
    res.json(await updateSender(Number(req.params.id), req.body));
  })
);

sendersRouter.delete(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    await deleteSender(Number(req.params.id));
    res.status(204).end();
  })
);
