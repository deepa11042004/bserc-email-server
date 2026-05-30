import './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { closeAllPools, appPool } from '../src/db/pools.js';
import { __testInMemS3, __testResetS3 } from '../src/modules/aws/s3.service.js';
import { ensureUser, tokenForUser, TEST_ADMIN, TEST_OPERATOR } from './helpers.js';

const app = buildApp();
let adminToken: string;
let operatorToken: string;

// Synthetic minimal PNG: real signature + IHDR length/type + width=800 + height=600,
// padded out so the parser's bounds reads succeed. The image bytes never reach a
// real decoder because TEST_NO_AWS short-circuits S3 to an in-memory store.
const buildSyntheticPng = (width: number, height: number): Buffer => {
  const buf = Buffer.alloc(64);
  // Signature
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  // IHDR chunk: 4 bytes length, 4 bytes type "IHDR"
  buf.writeUInt32BE(13, 8);
  Buffer.from('IHDR').copy(buf, 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
};

const PNG_B64 = buildSyntheticPng(800, 600).toString('base64');

before(async () => {
  await ensureUser(TEST_ADMIN);
  await ensureUser(TEST_OPERATOR);
  adminToken = await tokenForUser(TEST_ADMIN.email);
  operatorToken = await tokenForUser(TEST_OPERATOR.email);
  await appPool().query(`DELETE FROM cert_templates WHERE name LIKE 'cert_test_%'`);
  __testResetS3();
});
after(async () => { await closeAllPools(); });

let createdId: number;

test('operator creates a certificate template (PNG)', async () => {
  const r = await request(app)
    .post('/api/cert-templates')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      name: 'cert_test_basic',
      description: 'Basic test cert',
      image: { filename: 'cert.png', contentType: 'image/png', data: PNG_B64 },
    });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.name, 'cert_test_basic');
  assert.equal(r.body.image_width, 800);
  assert.equal(r.body.image_height, 600);
  assert.equal(r.body.image_content_type, 'image/png');
  assert.match(r.body.image_s3_key, /^cert-templates\/\d+\//);
  assert.match(r.body.image_url, /s3\.local\/fake/);
  createdId = r.body.id;
});

test('uploaded image bytes land in (mock) S3', async () => {
  const tpl = await request(app)
    .get(`/api/cert-templates/${createdId}`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(tpl.status, 200);
  const obj = __testInMemS3.get(tpl.body.image_s3_key);
  assert.ok(obj, 'expected image bytes to be present in the in-memory S3 store');
  assert.equal(obj!.contentType, 'image/png');
});

test('rejects mismatched content-type vs bytes', async () => {
  const r = await request(app)
    .post('/api/cert-templates')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      name: 'cert_test_mismatch',
      image: { filename: 'lies.jpg', contentType: 'image/jpeg', data: PNG_B64 },
    });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /does not match/i);
});

test('rejects non-image bytes', async () => {
  const r = await request(app)
    .post('/api/cert-templates')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      name: 'cert_test_garbage',
      image: {
        filename: 'x.png',
        contentType: 'image/png',
        data: Buffer.from('not an image at all').toString('base64'),
      },
    });
  assert.equal(r.status, 400);
});

test('list templates returns the new one', async () => {
  const r = await request(app)
    .get('/api/cert-templates')
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.find((t: any) => t.id === createdId));
});

test('update template name', async () => {
  const r = await request(app)
    .put(`/api/cert-templates/${createdId}`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({ name: 'cert_test_basic_updated' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'cert_test_basic_updated');
});

test('replace placeholders', async () => {
  const r = await request(app)
    .put(`/api/cert-templates/${createdId}/placeholders`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      placeholders: [
        { placeholderKey: 'name', x: 400, y: 300, fontSizePt: 32, textAlign: 'CENTER' },
        { placeholderKey: 'certificate_id', x: 100, y: 550, fontSizePt: 12, isSerial: true },
        { placeholderKey: 'verification_qr', x: 700, y: 500, width: 80, height: 80, isQr: true },
      ],
    });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.length, 3);
  const keys = r.body.map((p: any) => p.placeholder_key).sort();
  assert.deepEqual(keys, ['certificate_id', 'name', 'verification_qr']);
});

test('replacing placeholders is idempotent and overwrites', async () => {
  const r = await request(app)
    .put(`/api/cert-templates/${createdId}/placeholders`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      placeholders: [
        { placeholderKey: 'name', x: 400, y: 320, fontSizePt: 36 },
      ],
    });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].font_size_pt, 36);
});

test('rejects placeholder outside image bounds', async () => {
  const r = await request(app)
    .put(`/api/cert-templates/${createdId}/placeholders`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      placeholders: [{ placeholderKey: 'name', x: 99999, y: 0 }],
    });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /outside the image/i);
});

test('rejects duplicate placeholder key', async () => {
  const r = await request(app)
    .put(`/api/cert-templates/${createdId}/placeholders`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      placeholders: [
        { placeholderKey: 'name', x: 1, y: 1 },
        { placeholderKey: 'name', x: 2, y: 2 },
      ],
    });
  assert.equal(r.status, 400);
});

test('operator cannot delete (admin only)', async () => {
  const r = await request(app)
    .delete(`/api/cert-templates/${createdId}`)
    .set('authorization', `Bearer ${operatorToken}`);
  assert.equal(r.status, 403);
});

test('admin deletes template and S3 object is gone', async () => {
  const before = await request(app)
    .get(`/api/cert-templates/${createdId}`)
    .set('authorization', `Bearer ${adminToken}`);
  const s3Key = before.body.image_s3_key;
  assert.ok(__testInMemS3.has(s3Key));

  const r = await request(app)
    .delete(`/api/cert-templates/${createdId}`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(r.status, 204);
  assert.equal(__testInMemS3.has(s3Key), false);

  const after = await request(app)
    .get(`/api/cert-templates/${createdId}`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(after.status, 404);
});

test('placeholders cascade on template delete', async () => {
  // Create a new template, add placeholders, delete template, verify cascade
  const create = await request(app)
    .post('/api/cert-templates')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      name: 'cert_test_cascade',
      image: { filename: 'c.png', contentType: 'image/png', data: PNG_B64 },
    });
  const id = create.body.id;
  await request(app)
    .put(`/api/cert-templates/${id}/placeholders`)
    .set('authorization', `Bearer ${adminToken}`)
    .send({ placeholders: [{ placeholderKey: 'foo', x: 1, y: 1 }] });

  await request(app)
    .delete(`/api/cert-templates/${id}`)
    .set('authorization', `Bearer ${adminToken}`);

  const [rows]: any = await appPool().query(
    'SELECT COUNT(*) AS n FROM cert_placeholders WHERE template_id = ?',
    [id]
  );
  assert.equal(Number(rows[0].n), 0);
});

test('unauthenticated requests rejected', async () => {
  const r = await request(app).get('/api/cert-templates');
  assert.equal(r.status, 401);
});
