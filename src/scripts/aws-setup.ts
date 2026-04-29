/**
 * One-time AWS infrastructure bootstrap.
 * - Creates SQS queue + DLQ if missing
 * - Creates SNS topic for SES events if missing
 * - Creates SES configuration set + event destination -> SNS topic
 *
 * Outputs the URLs/ARNs you need to put back into .env.
 *
 * Usage: npm run infra:setup
 */
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import {
  CreateTopicCommand,
  ListTopicsCommand,
} from '@aws-sdk/client-sns';
import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  DescribeConfigurationSetCommand,
} from '@aws-sdk/client-ses';
import { sqs, sns, ses } from '../modules/aws/clients.js';
import { env } from '../config/env.js';
import { logger } from '../common/logger.js';

async function ensureQueue(name: string): Promise<{ url: string; arn: string }> {
  try {
    const out = await sqs().send(new GetQueueUrlCommand({ QueueName: name }));
    const url = out.QueueUrl!;
    const attrs = await sqs().send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] })
    );
    return { url, arn: attrs.Attributes!.QueueArn! };
  } catch (e: any) {
    if (e?.name !== 'QueueDoesNotExist' && e?.Code !== 'AWS.SimpleQueueService.NonExistentQueue') {
      // ignore and try create
    }
  }
  const created = await sqs().send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        VisibilityTimeout: String(env.WORKER_VISIBILITY_TIMEOUT_SEC),
        MessageRetentionPeriod: '345600', // 4 days
        ReceiveMessageWaitTimeSeconds: '20',
      },
    })
  );
  const url = created.QueueUrl!;
  const attrs = await sqs().send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] })
  );
  return { url, arn: attrs.Attributes!.QueueArn! };
}

async function attachDlq(mainUrl: string, dlqArn: string) {
  await sqs().send(
    new SetQueueAttributesCommand({
      QueueUrl: mainUrl,
      Attributes: {
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 6 }),
      },
    })
  );
}

async function ensureTopic(name: string): Promise<string> {
  let token: string | undefined;
  do {
    const out = await sns().send(new ListTopicsCommand({ NextToken: token }));
    for (const t of out.Topics ?? []) {
      if (t.TopicArn?.endsWith(`:${name}`)) return t.TopicArn;
    }
    token = out.NextToken;
  } while (token);
  const created = await sns().send(new CreateTopicCommand({ Name: name }));
  return created.TopicArn!;
}

async function ensureSesConfigSet(name: string, topicArn: string) {
  try {
    await ses().send(new DescribeConfigurationSetCommand({ ConfigurationSetName: name }));
    logger.info({ name }, 'SES configuration set exists');
  } catch (e: any) {
    if (e?.name === 'ConfigurationSetDoesNotExist') {
      await ses().send(
        new CreateConfigurationSetCommand({ ConfigurationSet: { Name: name } })
      );
      logger.info({ name }, 'Created SES configuration set');
    } else {
      throw e;
    }
  }

  try {
    await ses().send(
      new CreateConfigurationSetEventDestinationCommand({
        ConfigurationSetName: name,
        EventDestination: {
          Name: 'sns-events',
          Enabled: true,
          MatchingEventTypes: [
            'send',
            'delivery',
            'bounce',
            'complaint',
            'reject',
            'open',
            'click',
            'renderingFailure',
          ],
          SNSDestination: { TopicARN: topicArn },
        },
      })
    );
    logger.info('Created SES event destination -> SNS');
  } catch (e: any) {
    if (e?.name === 'EventDestinationAlreadyExists') {
      logger.info('SES event destination already exists');
    } else {
      throw e;
    }
  }
}

async function main() {
  logger.info({ region: env.AWS_REGION }, 'Bootstrapping AWS infra');

  const dlq = await ensureQueue(env.SQS_DLQ_NAME);
  logger.info({ url: dlq.url, arn: dlq.arn }, 'DLQ ready');

  const main = await ensureQueue(env.SQS_QUEUE_NAME);
  logger.info({ url: main.url, arn: main.arn }, 'Main queue ready');

  await attachDlq(main.url, dlq.arn);
  logger.info('Attached DLQ to main queue (maxReceiveCount=6)');

  const topicArn = await ensureTopic(env.SNS_TOPIC_NAME);
  logger.info({ topicArn }, 'SNS topic ready');

  if (env.SES_CONFIGURATION_SET) {
    await ensureSesConfigSet(env.SES_CONFIGURATION_SET, topicArn);
  }

  // eslint-disable-next-line no-console
  console.log('\n---  Add these to your .env  ---');
  console.log(`SQS_QUEUE_URL=${main.url}`);
  console.log(`SQS_DLQ_URL=${dlq.url}`);
  console.log(`SNS_TOPIC_ARN=${topicArn}`);
  console.log('--------------------------------\n');
  console.log('Subscribe your webhook URL to the SNS topic, e.g.:');
  console.log(
    `aws sns subscribe --topic-arn ${topicArn} --protocol https --notification-endpoint https://YOUR_DOMAIN${env.WEBHOOK_PATH}`
  );
}

main().catch((e) => {
  logger.error({ err: e }, 'AWS setup failed');
  process.exit(1);
});
