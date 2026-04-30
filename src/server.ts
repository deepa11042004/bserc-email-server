import { env } from './config/env.js';
import { logger } from './common/logger.js';
import { closeAllPools } from './db/pools.js';
import { buildApp } from './app.js';

const app = buildApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, swagger: `http://localhost:${env.PORT}/swagger` },
    'API listening'
  );
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
