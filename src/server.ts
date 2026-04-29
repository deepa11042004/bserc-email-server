import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
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
import { webhookRouter } from './modules/webhooks/ses.webhook.js';
import { closeAllPools, appPool } from './db/pools.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(pinoHttp({ logger }));

// Public webhook endpoint must be mounted *before* the global JSON parser so the
// router can use its own (text/json-permissive) parser.
app.use(env.WEBHOOK_PATH, webhookRouter);

app.use(express.json({ limit: '20mb' }));

// Health
app.get('/health', async (_req: Request, res: Response) => {
  try {
    await appPool().query('SELECT 1');
    res.json({ status: 'ok', service: 'email-server', time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'error', db: 'unreachable' });
  }
});

// Light rate limit on auth
const authLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true });
app.use('/api/auth', authLimiter, authRouter);

app.use('/api/templates', templatesRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/suppression', suppressionRouter);

// 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  req.log?.error?.({ err }, 'Unhandled error');
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
};
app.use(errorHandler);

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
});

const shutdown = (sig: string) => {
  logger.info({ sig }, 'API shutting down');
  server.close(async () => {
    await closeAllPools();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
