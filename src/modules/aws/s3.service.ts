import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3 } from './clients.js';
import { env } from '../../config/env.js';

export const uploadToS3 = async (key: string, body: Buffer, contentType: string): Promise<void> => {
  await s3().send(
    new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
};

export const downloadFromS3 = async (key: string): Promise<Buffer> => {
  const res = await s3().send(
    new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key })
  );
  const stream = res.Body as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

export const deleteFromS3 = async (key: string): Promise<void> => {
  await s3().send(
    new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key })
  );
};

export const getPresignedDownloadUrl = (key: string, expiresInSec = 3600): Promise<string> =>
  getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }),
    { expiresIn: expiresInSec }
  );
