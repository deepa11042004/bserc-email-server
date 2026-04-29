import { env } from './config/env.js';
import { logger } from './common/logger.js';
import { workerLoop } from './modules/workers/sender.js';
import { closeAllPools } from './db/pools.js';

const ac = new AbortController();
const shutdown = (sig: string) => {
  logger.info({ sig }, 'Worker shutting down');
  ac.abort();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

workerLoop({ concurrency: env.WORKER_CONCURRENCY, signal: ac.signal })
  .catch((e) => logger.error({ err: e }, 'Worker fatal'))
  .finally(async () => {
    await closeAllPools();
    process.exit(0);
  });
