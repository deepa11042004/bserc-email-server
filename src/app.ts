import express, { type ErrorRequestHandler, type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { logger } from './common/logger.js';
import { HttpError } from './common/errors.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { templatesRouter } from './modules/templates/templates.routes.js';
import { campaignsRouter } from './modules/campaigns/campaigns.routes.js';
import { suppressionRouter } from './modules/suppression/suppression.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { sendersRouter } from './modules/senders/senders.routes.js';
import { certTemplatesRouter } from './modules/certificates/cert-templates.routes.js';
import { certBatchesRouter } from './modules/certificates/cert-batches.routes.js';
import { certPublicRouter } from './modules/certificates/cert-public.routes.js';
import { webhookRouter } from './modules/webhooks/ses.webhook.js';
import { mountSwagger } from './openapi/swagger.js';
import { appPool } from './db/pools.js';

export const buildApp = (): Express => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(
    cors({
      origin: env.NODE_ENV === 'production' ? true : '*',
      credentials: true,
      exposedHeaders: ['Content-Length'],
    })
  );
  app.use(pinoHttp({ logger, autoLogging: env.NODE_ENV !== 'test' }));

  // Webhook router uses its own permissive parser; mount before global JSON.
  app.use(env.WEBHOOK_PATH, webhookRouter);

  // 75mb accommodates ~50mb participant spreadsheets uploaded as base64 in JSON.
  app.use(express.json({ limit: '75mb' }));

  // Health endpoints
  app.get('/live', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.get('/ready', async (_req: Request, res: Response) => {
    try {
      await appPool().query('SELECT 1');
      res.json({ status: 'ready', db: 'ok' });
    } catch {
      res.status(503).json({ status: 'not_ready', db: 'unreachable' });
    }
  });

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await appPool().query('SELECT 1');
      res.json({ status: 'ok', service: 'email-server', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'error', db: 'unreachable' });
    }
  });

  // Swagger / OpenAPI
  mountSwagger(app);

  // Routers
  const authLimiter = rateLimit({
    windowMs: 60_000,
    max: env.NODE_ENV === 'test' ? 1000 : 30,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/auth', authLimiter, authRouter);
  app.use('/api/templates', templatesRouter);
  app.use('/api/campaigns', campaignsRouter);
  app.use('/api/suppression', suppressionRouter);
  app.use('/api/senders', sendersRouter);
  app.use('/api/cert-templates', certTemplatesRouter);
  app.use('/api/cert-batches', certBatchesRouter);
  app.use('/api/public/cert', certPublicRouter);
  app.use('/api/admin', adminRouter);

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    req.log?.error?.({ err }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(errorHandler);

  return app;
};
