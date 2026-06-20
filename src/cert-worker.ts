import { env } from './config/env.js';
import { logger } from './common/logger.js';
import { appPool, closeAllPools } from './db/pools.js';
import {
  deleteCertJob,
  extendCertVisibility,
  receiveCertJobs,
  type ReceivedCertJob,
} from './modules/certificates/cert-queue.service.js';
import { processCertJob } from './modules/certificates/cert-render-job.js';

let running = true;
let inFlight = 0;

const completeBatchIfDone = async (batchId: number) => {
  const [rows]: any = await appPool().query(
    `SELECT total_rows, rendered_count, failed_count FROM cert_batches WHERE id = ? LIMIT 1`,
    [batchId]
  );
  const r = rows[0];
  if (!r) return;
  const total = Number(r.total_rows);
  const done = Number(r.rendered_count) + Number(r.failed_count);
  if (total > 0 && done >= total) {
    await appPool().query(
      `UPDATE cert_batches SET status = 'RENDERED', completed_at = NOW()
        WHERE id = ? AND status = 'RENDERING'`,
      [batchId]
    );
  }
};

const handleJob = async (m: ReceivedCertJob): Promise<void> => {
  const { batchId, recipientId } = m.job;
  try {
    await processCertJob(batchId, recipientId);
    await deleteCertJob(m.receiptHandle);
    await completeBatchIfDone(batchId);
  } catch (e: any) {
    // Inspect retry_count to decide whether to leave the message for SQS redelivery.
    const [rows]: any = await appPool().query(
      'SELECT retry_count FROM cert_recipients WHERE id = ? LIMIT 1',
      [recipientId]
    );
    const retries = Number(rows[0]?.retry_count ?? 0);
    if (retries >= env.CERT_MAX_RETRIES) {
      logger.error({ batchId, recipientId, err: e?.message }, 'Cert job exceeded max retries; dropping');
      await deleteCertJob(m.receiptHandle);
      await completeBatchIfDone(batchId);
    } else {
      logger.warn({ batchId, recipientId, retries, err: e?.message }, 'Cert job failed; will retry');
      // Let SQS redeliver after visibility timeout. Optionally extend so we don't redeliver too quickly.
      try { await extendCertVisibility(m.receiptHandle, env.CERT_WORKER_VISIBILITY_TIMEOUT_SEC); } catch { /* ignore */ }
    }
  }
};

const loop = async (): Promise<void> => {
  logger.info(
    {
      concurrency: env.CERT_WORKER_CONCURRENCY,
      batchSize: env.CERT_WORKER_BATCH_SIZE,
    },
    'Cert worker started'
  );
  let consecutiveErrors = 0;
  while (running) {
    if (inFlight >= env.CERT_WORKER_CONCURRENCY) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    const want = Math.max(1, env.CERT_WORKER_CONCURRENCY - inFlight);
    let messages: ReceivedCertJob[] = [];
    try {
      messages = await receiveCertJobs(Math.min(want, env.CERT_WORKER_BATCH_SIZE));
      consecutiveErrors = 0;  // Reset on success
    } catch (e) {
      consecutiveErrors++;
      // Exponential backoff: 2s, 4s, 8s, 16s, 32s (capped)
      const delayMs = Math.min(2000 * Math.pow(2, consecutiveErrors - 1), 60000);
      logger.error({ err: e, consecutiveErrors, nextRetryMs: delayMs }, 'SQS receive failed (cert-worker)');
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    if (!messages.length) continue;
    for (const m of messages) {
      inFlight++;
      handleJob(m)
        .catch((e) => logger.error({ err: e }, 'Unhandled cert job error'))
        .finally(() => { inFlight--; });
    }
  }
  // drain
  while (inFlight > 0) await new Promise((r) => setTimeout(r, 100));
};

const shutdown = (sig: string) => {
  logger.info({ sig }, 'Cert worker shutting down');
  running = false;
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

loop()
  .catch((e) => {
    logger.error({ err: e }, 'Cert worker crashed');
    process.exitCode = 1;
  })
  .finally(() => closeAllPools());
