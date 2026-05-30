import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler.js';
import { validateBody } from '../../common/validate.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import {
  createCertTemplate,
  deleteCertTemplate,
  getCertTemplate,
  listCertTemplates,
  listPlaceholders,
  replacePlaceholders,
  updateCertTemplate,
} from './cert-templates.service.js';

export const certTemplatesRouter = Router();
certTemplatesRouter.use(requireAuth);

const ImageBody = z.object({
  filename: z.string().min(1).max(500),
  contentType: z.enum(['image/png', 'image/jpeg', 'image/jpg']),
  data: z.string().min(1), // base64
});

const CreateBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).nullish(),
  image: ImageBody,
});

const UpdateBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullish(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
});

const PlaceholderBody = z.object({
  placeholderKey: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_]+$/),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(0).optional(),
  height: z.number().int().min(0).optional(),
  fontFamily: z.string().min(1).max(128).optional(),
  fontSizePt: z.number().int().min(6).max(200).optional(),
  fontColorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  fontWeight: z.enum(['NORMAL', 'BOLD']).optional(),
  textAlign: z.enum(['LEFT', 'CENTER', 'RIGHT']).optional(),
  isQr: z.boolean().optional(),
  isSerial: z.boolean().optional(),
  maxLength: z.number().int().min(1).max(2000).optional(),
  sortOrder: z.number().int().optional(),
});

const PlaceholdersBody = z.object({
  placeholders: z.array(PlaceholderBody).max(50),
});

certTemplatesRouter.post(
  '/',
  requireRole('ADMIN', 'OPERATOR'),
  validateBody(CreateBody),
  asyncHandler(async (req, res) => {
    const t = await createCertTemplate(req.body, req.user!.id);
    res.status(201).json(t);
  })
);

certTemplatesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await listCertTemplates({
      status: req.query.status as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    res.json(rows);
  })
);

certTemplatesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await getCertTemplate(Number(req.params.id)));
  })
);

certTemplatesRouter.put(
  '/:id',
  requireRole('ADMIN', 'OPERATOR'),
  validateBody(UpdateBody),
  asyncHandler(async (req, res) => {
    res.json(await updateCertTemplate(Number(req.params.id), req.body));
  })
);

certTemplatesRouter.delete(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    await deleteCertTemplate(Number(req.params.id));
    res.status(204).end();
  })
);

certTemplatesRouter.get(
  '/:id/placeholders',
  asyncHandler(async (req, res) => {
    res.json(await listPlaceholders(Number(req.params.id)));
  })
);

certTemplatesRouter.put(
  '/:id/placeholders',
  requireRole('ADMIN', 'OPERATOR'),
  validateBody(PlaceholdersBody),
  asyncHandler(async (req, res) => {
    const out = await replacePlaceholders(Number(req.params.id), req.body.placeholders);
    res.json(out);
  })
);
