import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3 } from './clients.js';
import { env } from '../../config/env.js';

// In-memory store used when TEST_NO_AWS=true so tests don't need real S3.
const inMemS3 = new Map<string, { body: Buffer; contentType: string }>();
export const __testInMemS3 = inMemS3;
export const __testResetS3 = () => inMemS3.clear();

export const uploadToS3 = async (key: string, body: Buffer, contentType: string): Promise<void> => {
  if (env.TEST_NO_AWS) {
    inMemS3.set(key, { body: Buffer.from(body), contentType });
    return;
  }
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
  if (env.TEST_NO_AWS) {
    const o = inMemS3.get(key);
    if (!o) throw new Error(`S3 object not found (test): ${key}`);
    return o.body;
  }
  const res = await s3().send(
    new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key })
  );
  const stream = res.Body as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

export const deleteFromS3 = async (key: string): Promise<void> => {
  if (env.TEST_NO_AWS) {
    inMemS3.delete(key);
    return;
  }
  await s3().send(
    new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key })
  );
};

export const getPresignedDownloadUrl = (key: string, expiresInSec = 3600): Promise<string> => {
  if (env.TEST_NO_AWS) {
    return Promise.resolve(`https://s3.local/fake/${encodeURIComponent(key)}?exp=${expiresInSec}`);
  }
  return getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }),
    { expiresIn: expiresInSec }
  );
};
