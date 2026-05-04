import { SESClient } from '@aws-sdk/client-ses';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SNSClient } from '@aws-sdk/client-sns';
import { S3Client } from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';

const credentials = {
  accessKeyId: env.AWS_ACCESS_KEY_ID,
  secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
};

let _ses: SESClient | null = null;
let _sqs: SQSClient | null = null;
let _sns: SNSClient | null = null;
let _s3: S3Client | null = null;

export const ses = () =>
  (_ses ??= new SESClient({ region: env.AWS_REGION, credentials }));

export const sqs = () =>
  (_sqs ??= new SQSClient({ region: env.AWS_REGION, credentials }));

export const sns = () =>
  (_sns ??= new SNSClient({ region: env.AWS_REGION, credentials }));

export const s3 = () =>
  (_s3 ??= new S3Client({ region: env.AWS_REGION, credentials }));
