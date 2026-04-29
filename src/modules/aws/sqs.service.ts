import {
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { sqs } from './clients.js';
import { env } from '../../config/env.js';
import { logger } from '../../common/logger.js';

export interface EmailJob {
  campaignId: number;
  recipientId: number;
}

const queueUrl = () => {
  if (!env.SQS_QUEUE_URL) {
    throw new Error('SQS_QUEUE_URL is not set. Run `npm run infra:setup` first.');
  }
  return env.SQS_QUEUE_URL;
};

export const enqueueJobs = async (jobs: EmailJob[]) => {
  if (!jobs.length) return 0;
  let sent = 0;
  for (let i = 0; i < jobs.length; i += 10) {
    const chunk = jobs.slice(i, i + 10);
    const cmd = new SendMessageBatchCommand({
      QueueUrl: queueUrl(),
      Entries: chunk.map((j, idx) => ({
        Id: `${j.campaignId}-${j.recipientId}-${idx}`,
        MessageBody: JSON.stringify(j),
      })),
    });
    const out = await sqs().send(cmd);
    sent += out.Successful?.length ?? 0;
    if (out.Failed?.length) {
      logger.warn({ failed: out.Failed }, 'Some SQS messages failed in batch');
    }
  }
  return sent;
};

export interface ReceivedJob {
  receiptHandle: string;
  messageId: string;
  job: EmailJob;
}

export const receiveJobs = async (max = 10): Promise<ReceivedJob[]> => {
  const cmd = new ReceiveMessageCommand({
    QueueUrl: queueUrl(),
    MaxNumberOfMessages: Math.min(max, 10),
    WaitTimeSeconds: 20,
    VisibilityTimeout: env.WORKER_VISIBILITY_TIMEOUT_SEC,
  });
  const out = await sqs().send(cmd);
  if (!out.Messages?.length) return [];
  return out.Messages.map((m) => {
    let job: EmailJob;
    try {
      job = JSON.parse(m.Body || '{}');
    } catch {
      job = { campaignId: 0, recipientId: 0 };
    }
    return {
      receiptHandle: m.ReceiptHandle!,
      messageId: m.MessageId!,
      job,
    };
  });
};

export const deleteJob = async (receiptHandle: string) => {
  await sqs().send(new DeleteMessageCommand({ QueueUrl: queueUrl(), ReceiptHandle: receiptHandle }));
};

export const extendVisibility = async (receiptHandle: string, seconds: number) => {
  await sqs().send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl(),
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: seconds,
    })
  );
};
