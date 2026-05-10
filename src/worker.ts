import { env } from './config/env.js';
import { logger } from './common/logger.js';
import { workerLoop } from './modules/workers/sender.js';
import { appPool, closeAllPools } from './db/pools.js';

const ac = new AbortController();
const shutdown = (sig: string) => {
  logger.info({ sig }, 'Worker shutting down');
  ac.abort();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Validate critical config before starting the loop — failures appear clearly in logs.
if (!env.SQS_QUEUE_URL) {
  logger.error('SQS_QUEUE_URL is not set — worker cannot start. Run `npm run infra:setup` or set the env var.');
  process.exit(1);
}

logger.info(
  {
    sqsQueueUrl: env.SQS_QUEUE_URL,
    concurrency: env.WORKER_CONCURRENCY,
    batchSize: env.WORKER_BATCH_SIZE,
    visibilityTimeout: env.WORKER_VISIBILITY_TIMEOUT_SEC,
    sesRatePerSec: env.SES_MAX_SEND_RATE_PER_SEC,
  },
  'Worker config validated — connecting to DB'
);

// Verify DB connectivity before entering the loop.
appPool()
  .query('SELECT 1')
  .then(() => {
    logger.info('Worker DB connection OK — starting worker loop');
    return workerLoop({ concurrency: env.WORKER_CONCURRENCY, signal: ac.signal });
  })
  .catch((e) => logger.error({ err: e }, 'Worker fatal'))
  .finally(async () => {
    await closeAllPools();
    process.exit(0);
  });
