import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  LOG_LEVEL: z.string().default('info'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_EXPIRES_IN: z.string().default('12h'),

  SOURCE_DB_HOST: z.string(),
  SOURCE_DB_PORT: z.coerce.number().default(3306),
  SOURCE_DB_USER: z.string(),
  SOURCE_DB_PASSWORD: z.string(),
  SOURCE_DB_NAME: z.string(),

  APP_DB_HOST: z.string(),
  APP_DB_PORT: z.coerce.number().default(3306),
  APP_DB_USER: z.string(),
  APP_DB_PASSWORD: z.string(),
  APP_DB_NAME: z.string(),

  AWS_REGION: z.string(),
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),

  SES_DEFAULT_FROM_EMAIL: z.string().email(),
  SES_CONFIGURATION_SET: z.string().optional(),
  SES_MAX_SEND_RATE_PER_SEC: z.coerce.number().default(14),

  SQS_QUEUE_NAME: z.string(),
  SQS_DLQ_NAME: z.string(),
  SQS_QUEUE_URL: z.string().optional(),
  SQS_DLQ_URL: z.string().optional(),

  SNS_TOPIC_NAME: z.string(),
  SNS_TOPIC_ARN: z.string().optional(),

  WORKER_CONCURRENCY: z.coerce.number().default(10),
  WORKER_BATCH_SIZE: z.coerce.number().min(1).max(10).default(10),
  WORKER_VISIBILITY_TIMEOUT_SEC: z.coerce.number().default(120),

  ALLOWED_RECIPIENT_TABLES: z.string().default(''),
  ALLOW_RAW_QUERY: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  WEBHOOK_PATH: z.string().default('/api/webhooks/ses'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const allowedRecipientTables = env.ALLOWED_RECIPIENT_TABLES
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
