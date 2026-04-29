import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler.js';
import { validateBody } from '../../common/validate.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import { appPool } from '../../db/pools.js';
import { notFound } from '../../common/errors.js';

export const suppressionRouter = Router();
suppressionRouter.use(requireAuth);

const AddSchema = z.object({
  email: z.string().email(),
  reason: z.enum(['BOUNCE', 'COMPLAINT', 'MANUAL', 'UNSUBSCRIBE']).default('MANUAL'),
  notes: z.string().optional(),
});

suppressionRouter.post(
  '/',
  requireRole('ADMIN', 'OPERATOR'),
  validateBody(AddSchema),
  asyncHandler(async (req, res) => {
    const { email, reason, notes } = req.body as z.infer<typeof AddSchema>;
    await appPool().query(
      `INSERT INTO suppression_list (email, reason, notes) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE reason = VALUES(reason), notes = VALUES(notes)`,
      [email.toLowerCase(), reason, notes ?? null]
    );
    res.status(201).json({ email: email.toLowerCase(), reason, notes: notes ?? null });
  })
);

suppressionRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const [rows]: any = await appPool().query(
      'SELECT email, reason, notes, created_at FROM suppression_list ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
    res.json(rows);
  })
);

suppressionRouter.delete(
  '/:email',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const [r]: any = await appPool().query('DELETE FROM suppression_list WHERE email = ?', [
      String(req.params.email).toLowerCase(),
    ]);
    if (r.affectedRows === 0) throw notFound('Email not in suppression list');
    res.status(204).end();
  })
);
