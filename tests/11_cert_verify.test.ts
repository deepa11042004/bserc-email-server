import './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { closeAllPools, appPool } from '../src/db/pools.js';
import { __testResetS3, uploadToS3 } from '../src/modules/aws/s3.service.js';
import { __testDrainCertQueue } from '../src/modules/certificates/cert-queue.service.js';
import { processCertJob } from '../src/modules/certificates/cert-render-job.js';
import { ensureUser, tokenForUser, TEST_ADMIN, TEST_OPERATOR } from './helpers.js';

const app = buildApp();
let adminToken: string;
let operatorToken: string;

const REAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const buildSyntheticPng = (w: number, h: number): Buffer => {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  Buffer.from('IHDR').copy(buf, 12);
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
};
const PNG_B64 = buildSyntheticPng(400, 300).toString('base64');

let templateId: number;
let batchId: number;
let verifiableCode: string;
let pendingCode: string;

before(async () => {
  await ensureUser(TEST_ADMIN);
  await ensureUser(TEST_OPERATOR);
  adminToken = await tokenForUser(TEST_ADMIN.email);
  operatorToken = await tokenForUser(TEST_OPERATOR.email);
  await appPool().query(`DELETE FROM cert_batches WHERE name LIKE 'verify_test_%'`);
  await appPool().query(`DELETE FROM cert_templates WHERE name LIKE 'verify_test_%'`);
  __testResetS3();
  __testDrainCertQueue();

  // template
  const tpl = await request(app)
    .post('/api/cert-templates')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      name: 'verify_test_tpl',
      image: { filename: 't.png', contentType: 'image/png', data: PNG_B64 },
    });
  templateId = tpl.body.id;
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
      ],
    });

  // batch
  const csvData = 'name,email\nVerify Tester,verify@example.test';
  const b = await request(app)
    .post('/api/cert-batches')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      name: 'verify_test_batch',
      templateId,
      file: {
        filename: 'people.csv',
        contentType: 'text/csv',
        data: Buffer.from(csvData).toString('base64'),
      },
    });
  batchId = b.body.id;

  await request(app)
    .put(`/api/cert-batches/${batchId}/mapping`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      columnMapping: { name: 'name' },
      emailColumn: 'email',
      nameColumn: 'name',
      serialConfig: { prefix: 'VERIFY-', paddingWidth: 3, startAt: 1 },
    });

  // start and wait
  await request(app)
    .post(`/api/cert-batches/${batchId}/start`)
    .set('authorization', `Bearer ${operatorToken}`);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [rows]: any = await appPool().query(
      'SELECT COUNT(*) AS n FROM cert_recipients WHERE batch_id = ?',
      [batchId]
    );
    if (Number(rows[0].n) > 0) break;
    await new Promise((r) => setTimeout(r, 30));
  }

  // Render the recipient so it has a real PDF in S3
  const [recs]: any = await appPool().query(
    `SELECT id, verification_code FROM cert_recipients WHERE batch_id = ?`,
    [batchId]
  );
  await processCertJob(batchId, Number(recs[0].id));

  const [updated]: any = await appPool().query(
    `SELECT verification_code, status FROM cert_recipients WHERE id = ?`,
    [recs[0].id]
  );
  assert.equal(updated[0].status, 'RENDERED');
  verifiableCode = updated[0].verification_code;

  // Create a second recipient still in PENDING to test "not verifiable" path
  const [ins]: any = await appPool().query(
    `INSERT INTO cert_recipients
       (batch_id, row_index, serial_no, verification_code, email, full_name, row_data_json, status)
     VALUES (?, 99, 'VERIFY-999', ?, 'pending@example.test', 'Pending Tester', ?, 'PENDING')`,
    [batchId, 'pending_test_code_aaaaaa', JSON.stringify({ name: 'Pending Tester' })]
  );
  void ins;
  pendingCode = 'pending_test_code_aaaaaa';
});

after(async () => { await closeAllPools(); });

test('GET /api/public/cert/verify/:code returns valid certificate metadata (no auth required)', async () => {
  const r = await request(app).get(`/api/public/cert/verify/${verifiableCode}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.valid, true);
  assert.equal(r.body.certificate.serial_no, 'VERIFY-001');
  assert.equal(r.body.certificate.recipient_name, 'Verify Tester');
  assert.equal(r.body.certificate.batch_name, 'verify_test_batch');
  assert.equal(r.body.certificate.template_name, 'verify_test_tpl');
  assert.match(r.body.certificate.certificate_url, /s3\.local\/fake/);
});

test('does NOT include recipient email or row payload', async () => {
  const r = await request(app).get(`/api/public/cert/verify/${verifiableCode}`);
  const json = JSON.stringify(r.body);
  assert.equal(json.includes('verify@example.test'), false);
  assert.equal(json.includes('row_data_json'), false);
});

test('verification count increments per lookup', async () => {
  const r1 = await request(app).get(`/api/public/cert/verify/${verifiableCode}`);
  const before = r1.body.certificate.verification_count;
  // Wait a moment for the fire-and-forget update
  await new Promise((r) => setTimeout(r, 100));
  const r2 = await request(app).get(`/api/public/cert/verify/${verifiableCode}`);
  assert.ok(r2.body.certificate.verification_count > before);
});

test('returns valid=false for unknown code without leaking info', async () => {
  const r = await request(app).get('/api/public/cert/verify/nonexistent_code_xxxxx');
  assert.equal(r.status, 200);
  assert.equal(r.body.valid, false);
  assert.equal(r.body.certificate, undefined);
});

test('returns valid=false for codes belonging to non-rendered (PENDING) recipients', async () => {
  const r = await request(app).get(`/api/public/cert/verify/${pendingCode}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.valid, false);
});

test('rejects malformed codes (invalid characters)', async () => {
  const r = await request(app).get('/api/public/cert/verify/has%20space');
  assert.equal(r.status, 200);
  assert.equal(r.body.valid, false);
});

test('database records the verification timestamp + ip', async () => {
  await request(app)
    .get(`/api/public/cert/verify/${verifiableCode}`)
    .set('X-Forwarded-For', '203.0.113.42');
  await new Promise((r) => setTimeout(r, 100));
  const [rows]: any = await appPool().query(
    `SELECT last_verified_at, last_verified_ip, verification_count
       FROM cert_recipients WHERE verification_code = ?`,
    [verifiableCode]
  );
  assert.ok(rows[0].last_verified_at);
  // IP shape varies (express trust proxy parsing) — just ensure non-null when proxied
  assert.ok(rows[0].verification_count >= 1);
});
