import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler.js';
import { validateBody } from '../../common/validate.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import {
  addAttachment,
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplateAttachments,
  listTemplates,
  removeAttachment,
  updateTemplate,
} from './templates.service.js';
import { buildVars, render } from './placeholders.js';

export const templatesRouter = Router();
templatesRouter.use(requireAuth);

const TemplateBody = z.object({
  templateCode: z.string().min(2).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  templateName: z.string().min(1).max(255),
  subject: z.string().min(1).max(998),
  htmlBody: z.string().min(1),
  textBody: z.string().nullish(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
});

templatesRouter.post(
  '/',
  requireRole('ADMIN', 'OPERATOR'),
  validateBody(TemplateBody),
  asyncHandler(async (req, res) => {
    const t = await createTemplate(req.body, req.user!.id);
    res.status(201).json(t);
  })
);

const TemplatePatch = TemplateBody.partial();
templatesRouter.put(
  '/:id',
  requireRole('ADMIN', 'OPERATOR'),
  validateBody(TemplatePatch),
  asyncHandler(async (req, res) => {
    const t = await updateTemplate(Number(req.params.id), req.body);
    res.json(t);
  })
);

templatesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await listTemplates({
      status: req.query.status as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    res.json(rows);
  })
);

templatesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await getTemplate(Number(req.params.id)));
  })
);

templatesRouter.delete(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    await deleteTemplate(Number(req.params.id));
    res.status(204).end();
  })
);

const PreviewBody = z.object({
  vars: z.record(z.unknown()).default({}),
});
templatesRouter.post(
  '/:id/preview',
  validateBody(PreviewBody),
  asyncHandler(async (req, res) => {
    const t = await getTemplate(Number(req.params.id));
    const vars = buildVars({ email: 'preview@example.com', first_name: 'Preview', last_name: 'User', payload_json: req.body.vars });
    const subject = render(t.subject, vars);
    const html = render(t.html_body, vars, { html: false });
    const text = t.text_body ? render(t.text_body, vars) : null;
    res.json({
      subject: subject.output,
      htmlBody: html.output,
      textBody: text?.output ?? null,
      missingPlaceholders: [...new Set([...subject.missing, ...html.missing, ...(text?.missing ?? [])])],
    });
  })
);

// ----- Attachment routes -----

const AttachmentBody = z.object({
  filename: z.string().min(1).max(500),
  contentType: z.string().min(1).max(255),
  data: z.string().min(1), // base64
});

templatesRouter.get(
  '/:id/attachments',
  asyncHandler(async (req, res) => {
    const attachments = await listTemplateAttachments(Number(req.params.id), true);
    res.json(attachments);
  })
);

templatesRouter.post(
  '/:id/attachments',
  requireRole('ADMIN', 'OPERATOR'),
  validateBody(AttachmentBody),
  asyncHandler(async (req, res) => {
    const att = await addAttachment(Number(req.params.id), req.body);
    res.status(201).json(att);
  })
);

templatesRouter.delete(
  '/:id/attachments/:attachmentId',
  requireRole('ADMIN', 'OPERATOR'),
  asyncHandler(async (req, res) => {
    await removeAttachment(Number(req.params.id), Number(req.params.attachmentId));
    res.status(204).end();
  })
);
