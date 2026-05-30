import './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { closeAllPools, appPool } from '../src/db/pools.js';
import {
  __testResetS3,
  __testInMemS3,
  uploadToS3,
  downloadFromS3,
} from '../src/modules/aws/s3.service.js';
import {
  __testDrainCertQueue,
  __testInMemCertQueue,
} from '../src/modules/certificates/cert-queue.service.js';
import { processCertJob } from '../src/modules/certificates/cert-render-job.js';
import { renderCertificatePdf } from '../src/modules/certificates/cert-renderer.js';
import { formatSerial, generateVerificationCode } from '../src/modules/certificates/cert-materializer.js';
import { ensureUser, tokenForUser, TEST_ADMIN, TEST_OPERATOR } from './helpers.js';

const app = buildApp();
let adminToken: string;
let operatorToken: string;

// Real, embeddable 1x1 transparent PNG (well-known "tracking pixel" bytes).
// pdf-lib's embedPng needs a parseable PNG; our synthetic byte-header isn't enough.
const REAL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const REAL_PNG = Buffer.from(REAL_PNG_B64, 'base64');

// Real, embeddable 1x1 JPEG. embedJpg requires valid SOI...EOI structure.
const REAL_JPG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/' +
  '2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QA' +
  'HwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK' +
  'FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
  'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD7+ooooA//2Q==';
const REAL_JPG = Buffer.from(REAL_JPG_B64, 'base64');

// Header-only PNG (just signature + IHDR with real dimensions) for the probe path
// in Slice 1's API contract. embedPng can't render it, so we'll overwrite the
// S3 object bytes with REAL_PNG before any rendering happens.
const buildSyntheticPng = (width: number, height: number): Buffer => {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  Buffer.from('IHDR').copy(buf, 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
};
const PNG_B64 = buildSyntheticPng(1200, 900).toString('base64');

const csv = (rows: string[][]) => rows.map((r) => r.join(',')).join('\n');

let templateId: number;
let batchId: number;

before(async () => {
  await ensureUser(TEST_ADMIN);
  await ensureUser(TEST_OPERATOR);
  adminToken = await tokenForUser(TEST_ADMIN.email);
  operatorToken = await tokenForUser(TEST_OPERATOR.email);
  await appPool().query(`DELETE FROM cert_batches WHERE name LIKE 'render_test_%'`);
  await appPool().query(`DELETE FROM cert_templates WHERE name LIKE 'render_test_%'`);
  __testResetS3();
  __testDrainCertQueue();
});
after(async () => { await closeAllPools(); });

// REAL_JPG is kept for potential future JPEG-specific fixture tests; reference it
// so unused-import lint doesn't fire.
void REAL_JPG;

test('renderCertificatePdf produces a valid PDF for a real PNG template', async () => {
  const pdf = await renderCertificatePdf({
    templateImage: { bytes: REAL_PNG, contentType: 'image/png', width: 1, height: 1 },
    placeholders: [
      {
        id: 1, template_id: 1, placeholder_key: 'name',
        x: 0, y: 0, width: 0, height: 0,
        font_family: 'Helvetica', font_size_pt: 8, font_color_hex: '#000000',
        font_weight: 'NORMAL', text_align: 'LEFT',
        is_qr: 0, is_serial: 0, max_length: 200, sort_order: 0,
      },
      {
        id: 2, template_id: 1, placeholder_key: 'qr',
        x: 0, y: 0, width: 1, height: 1,
        font_family: 'Helvetica', font_size_pt: 8, font_color_hex: '#000000',
        font_weight: 'NORMAL', text_align: 'CENTER',
        is_qr: 1, is_serial: 0, max_length: 200, sort_order: 1,
      },
    ],
    values: { name: 'Alice' },
    verificationUrl: 'https://example.test/verify/abc',
  });
  assert.ok(pdf.length > 100);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
});

test('formatSerial pads and applies prefix/suffix', () => {
  assert.equal(formatSerial({ prefix: 'BSERC-', paddingWidth: 4, startAt: 1 }, 1), 'BSERC-0001');
  assert.equal(formatSerial({ prefix: '', suffix: '-2026', paddingWidth: 0, startAt: 1 }, 42), '42-2026');
  assert.equal(formatSerial(null, 7), '7');
});

test('generateVerificationCode produces unique 24-char codes', () => {
  const set = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const c = generateVerificationCode();
    assert.equal(c.length, 24);
    assert.match(c, /^[A-Za-z0-9_-]{24}$/);
    set.add(c);
  }
  assert.equal(set.size, 500);
});

test('setup: create cert template + READY batch', async () => {
  // Need a JPG template (synthetic PNG won't work for actual rendering) — upload via the API.
  // The API validates content-type vs bytes, so build a synthetic PNG and use that. For
  // rendering we'll swap in real JPG bytes in S3 below.
  const tpl = await request(app)
    .post('/api/cert-templates')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      name: 'render_test_tpl',
      image: { filename: 't.png', contentType: 'image/png', data: PNG_B64 },
    });
  assert.equal(tpl.status, 201);
  templateId = tpl.body.id;

  // Overwrite the on-S3 image bytes with an embeddable real PNG. We keep the same
  // s3 key so getCertTemplate still resolves; we just patch dimensions to match the
  // real bytes (1x1) so placeholder bounds validation passes for our test coords.
  await uploadToS3(tpl.body.image_s3_key, REAL_PNG, 'image/png');
  await appPool().query(
    `UPDATE cert_templates SET image_width = 400, image_height = 300 WHERE id = ?`,
    [templateId]
  );

  await request(app)
    .put(`/api/cert-templates/${templateId}/placeholders`)
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      placeholders: [
        { placeholderKey: 'name', x: 200, y: 100, fontSizePt: 18, textAlign: 'CENTER' },
        { placeholderKey: 'certificate_id', x: 50, y: 250, fontSizePt: 10, isSerial: true },
        { placeholderKey: 'qr', x: 320, y: 220, width: 60, height: 60, isQr: true },
      ],
    });

  // Upload a CSV → batch
  const csvData = csv([
    ['name', 'email'],
    ['Ada Lovelace', 'ada@example.test'],
    ['Alan Turing', 'alan@example.test'],
    ['Grace Hopper', 'grace@example.test'],
  ]);
  const b = await request(app)
    .post('/api/cert-batches')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      name: 'render_test_batch',
      templateId,
      file: {
        filename: 'people.csv',
        contentType: 'text/csv',
        data: Buffer.from(csvData).toString('base64'),
      },
    });
  assert.equal(b.status, 201);
  batchId = b.body.id;

  const m = await request(app)
    .put(`/api/cert-batches/${batchId}/mapping`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      columnMapping: { name: 'name' },
      emailColumn: 'email',
      nameColumn: 'name',
      serialConfig: { prefix: 'BSERC-', paddingWidth: 4, startAt: 1 },
    });
  assert.equal(m.status, 200);
  assert.equal(m.body.status, 'READY');
});

test('preview endpoint returns a PDF URL without materializing recipients', async () => {
  const r = await request(app)
    .get(`/api/cert-batches/${batchId}/preview?row=1`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.s3Key, /^cert-batches\/\d+\/previews\//);
  // verify the file actually landed in mock S3
  const bytes = await downloadFromS3(r.body.s3Key);
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF');

  // recipients should NOT have been materialized
  const [recs]: any = await appPool().query(
    'SELECT COUNT(*) AS n FROM cert_recipients WHERE batch_id = ?',
    [batchId]
  );
  assert.equal(Number(recs[0].n), 0);
});

test('start endpoint returns 202 and materializes recipients in background', async () => {
  __testDrainCertQueue();
  const r = await request(app)
    .post(`/api/cert-batches/${batchId}/start`)
    .set('authorization', `Bearer ${operatorToken}`);
  assert.equal(r.status, 202);
  assert.equal(r.body.status, 'RENDERING');

  // Wait for the background materialization to finish (bounded poll).
  const deadline = Date.now() + 5000;
  let count = 0;
  while (Date.now() < deadline) {
    const [rows]: any = await appPool().query(
      'SELECT COUNT(*) AS n FROM cert_recipients WHERE batch_id = ?',
      [batchId]
    );
    count = Number(rows[0].n);
    if (count >= 3) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.equal(count, 3, 'expected 3 recipients to be materialized');

  // SQS queue should also have 3 jobs enqueued
  assert.equal(__testInMemCertQueue.length, 3);
  for (const m of __testInMemCertQueue) {
    assert.equal(m.body.batchId, batchId);
  }
});

test('serials are assigned sequentially with the configured prefix + padding', async () => {
  const [rows]: any = await appPool().query(
    `SELECT serial_no FROM cert_recipients WHERE batch_id = ? ORDER BY row_index ASC`,
    [batchId]
  );
  const serials = rows.map((r: any) => r.serial_no);
  assert.deepEqual(serials, ['BSERC-0001', 'BSERC-0002', 'BSERC-0003']);
});

test('starting an already-running batch is rejected', async () => {
  const r = await request(app)
    .post(`/api/cert-batches/${batchId}/start`)
    .set('authorization', `Bearer ${operatorToken}`);
  assert.equal(r.status, 409);
});

test('processCertJob renders a recipient and uploads PDF to canonical S3 key', async () => {
  // Pick the first recipient
  const [rows]: any = await appPool().query(
    `SELECT id FROM cert_recipients WHERE batch_id = ? ORDER BY id ASC LIMIT 1`,
    [batchId]
  );
  const recipientId = Number(rows[0].id);

  await processCertJob(batchId, recipientId);

  const [after]: any = await appPool().query(
    'SELECT status, cert_s3_key FROM cert_recipients WHERE id = ?',
    [recipientId]
  );
  assert.equal(after[0].status, 'RENDERED');
  assert.match(after[0].cert_s3_key, /^certs\/\d+\/\d{2}\/\d+\.pdf$/);

  // Verify the PDF bytes
  const bytes = __testInMemS3.get(after[0].cert_s3_key);
  assert.ok(bytes);
  assert.equal(bytes!.body.subarray(0, 4).toString(), '%PDF');

  // Batch counter should bump
  const [b]: any = await appPool().query(
    'SELECT rendered_count FROM cert_batches WHERE id = ?',
    [batchId]
  );
  assert.equal(Number(b[0].rendered_count), 1);
});

test('processCertJob is idempotent on a RENDERED recipient (no-op)', async () => {
  const [rows]: any = await appPool().query(
    `SELECT id FROM cert_recipients WHERE batch_id = ? AND status = 'RENDERED' LIMIT 1`,
    [batchId]
  );
  const recipientId = Number(rows[0].id);
  const [b1]: any = await appPool().query(
    'SELECT rendered_count FROM cert_batches WHERE id = ?',
    [batchId]
  );
  await processCertJob(batchId, recipientId);
  const [b2]: any = await appPool().query(
    'SELECT rendered_count FROM cert_batches WHERE id = ?',
    [batchId]
  );
  assert.equal(Number(b1[0].rendered_count), Number(b2[0].rendered_count));
});

test('GET /:id/recipients returns paginated list', async () => {
  const r = await request(app)
    .get(`/api/cert-batches/${batchId}/recipients`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 3);
  // The one we just rendered should carry a presigned URL
  const rendered = r.body.find((x: any) => x.status === 'RENDERED');
  assert.ok(rendered);
  assert.match(rendered.cert_url, /s3\.local\/fake/);
});

test('retry a recipient re-enqueues it', async () => {
  // Force one into FAILED
  const [rows]: any = await appPool().query(
    `SELECT id FROM cert_recipients WHERE batch_id = ? AND status = 'PENDING' LIMIT 1`,
    [batchId]
  );
  const recipientId = Number(rows[0].id);
  await appPool().query(
    `UPDATE cert_recipients SET status = 'FAILED', error_reason = 'forced' WHERE id = ?`,
    [recipientId]
  );

  __testDrainCertQueue();
  const r = await request(app)
    .post(`/api/cert-batches/${batchId}/recipients/${recipientId}/retry`)
    .set('authorization', `Bearer ${operatorToken}`);
  assert.equal(r.status, 202);

  assert.equal(__testInMemCertQueue.length, 1);
  assert.equal(__testInMemCertQueue[0]!.body.recipientId, recipientId);

  const [after]: any = await appPool().query(
    'SELECT status FROM cert_recipients WHERE id = ?',
    [recipientId]
  );
  assert.equal(after[0].status, 'PENDING');
});

test('cancel batch transitions to CANCELLED', async () => {
  const r = await request(app)
    .post(`/api/cert-batches/${batchId}/cancel`)
    .set('authorization', `Bearer ${operatorToken}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'CANCELLED');
});
