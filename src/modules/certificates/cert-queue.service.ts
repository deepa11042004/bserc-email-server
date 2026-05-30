import {
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { sqs } from '../aws/clients.js';
import { env } from '../../config/env.js';
import { logger } from '../../common/logger.js';

export interface CertJob {
  batchId: number;
  recipientId: number;
}

const queueUrl = () => {
  if (!env.CERT_QUEUE_URL) {
    throw new Error('CERT_QUEUE_URL is not set. Provision the certificate render queue via aws-setup or env.');
  }
  return env.CERT_QUEUE_URL;
};

const inMem: { id: string; body: CertJob }[] = [];
export const __testInMemCertQueue = inMem;
export const __testDrainCertQueue = () => inMem.splice(0, inMem.length);

export const enqueueCertJobs = async (jobs: CertJob[]): Promise<number> => {
  if (!jobs.length) return 0;
  if (env.TEST_NO_AWS) {
    for (const j of jobs) inMem.push({ id: `mem-${j.batchId}-${j.recipientId}`, body: j });
    return jobs.length;
  }
  let sent = 0;
  for (let i = 0; i < jobs.length; i += 10) {
    const chunk = jobs.slice(i, i + 10);
    const cmd = new SendMessageBatchCommand({
      QueueUrl: queueUrl(),
      Entries: chunk.map((j, idx) => ({
        Id: `${j.batchId}-${j.recipientId}-${idx}`,
        MessageBody: JSON.stringify(j),
      })),
    });
    const out = await sqs().send(cmd);
    sent += out.Successful?.length ?? 0;
    if (out.Failed?.length) {
      logger.warn({ failed: out.Failed }, 'Some cert SQS messages failed in batch');
    }
  }
  return sent;
};

export interface ReceivedCertJob {
  receiptHandle: string;
  messageId: string;
  job: CertJob;
}

export const receiveCertJobs = async (max = 5): Promise<ReceivedCertJob[]> => {
  if (env.TEST_NO_AWS) {
    const out = inMem.splice(0, Math.min(max, inMem.length));
    return out.map((m, i) => ({ receiptHandle: `mem-r-${i}`, messageId: m.id, job: m.body }));
  }
  const cmd = new ReceiveMessageCommand({
    QueueUrl: queueUrl(),
    MaxNumberOfMessages: Math.min(max, 10),
    WaitTimeSeconds: 20,
    VisibilityTimeout: env.CERT_WORKER_VISIBILITY_TIMEOUT_SEC,
  });
  const out = await sqs().send(cmd);
  if (!out.Messages?.length) return [];
  return out.Messages.map((m) => {
    let job: CertJob;
    try { job = JSON.parse(m.Body || '{}'); }
    catch { job = { batchId: 0, recipientId: 0 }; }
    return { receiptHandle: m.ReceiptHandle!, messageId: m.MessageId!, job };
  });
};

export const deleteCertJob = async (receiptHandle: string): Promise<void> => {
  if (env.TEST_NO_AWS) return;
  await sqs().send(new DeleteMessageCommand({ QueueUrl: queueUrl(), ReceiptHandle: receiptHandle }));
};

export const extendCertVisibility = async (receiptHandle: string, seconds: number): Promise<void> => {
  if (env.TEST_NO_AWS) return;
  await sqs().send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl(),
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: seconds,
    })
  );
};
