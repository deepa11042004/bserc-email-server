import './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { closeAllPools, appPool } from '../src/db/pools.js';
import { __testResetS3 } from '../src/modules/aws/s3.service.js';
import { ensureUser, tokenForUser, TEST_ADMIN, TEST_OPERATOR } from './helpers.js';

const app = buildApp();
let adminToken: string;
let operatorToken: string;

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

before(async () => {
  await ensureUser(TEST_ADMIN);
  await ensureUser(TEST_OPERATOR);
  adminToken = await tokenForUser(TEST_ADMIN.email);
  operatorToken = await tokenForUser(TEST_OPERATOR.email);
  // Clean prior runs (FK order: recipients/serials/audit cascade with batches; placeholders cascade with templates)
  await appPool().query(`DELETE FROM cert_batches WHERE name LIKE 'batch_test_%'`);
  await appPool().query(`DELETE FROM cert_templates WHERE name LIKE 'cert_batch_test_%'`);
  __testResetS3();

  // Create a template with placeholders for our batch tests
  const tpl = await request(app)
    .post('/api/cert-templates')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      name: 'cert_batch_test_tpl',
      image: { filename: 't.png', contentType: 'image/png', data: PNG_B64 },
    });
  templateId = tpl.body.id;
  await request(app)
    .put(`/api/cert-templates/${templateId}/placeholders`)
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      placeholders: [
        { placeholderKey: 'name', x: 600, y: 400, fontSizePt: 32 },
        { placeholderKey: 'institution', x: 600, y: 500, fontSizePt: 24 },
        { placeholderKey: 'certificate_id', x: 100, y: 800, fontSizePt: 12, isSerial: true },
        { placeholderKey: 'verification_qr', x: 1000, y: 750, width: 100, height: 100, isQr: true },
      ],
    });
});
after(async () => { await closeAllPools(); });

let batchId: number;

test('operator creates a batch from CSV; columns + sample rows detected', async () => {
  const csvData = csv([
    ['Full Name', 'Institution', 'Email'],
    ['Ada Lovelace', 'Acme University', 'ada@example.test'],
    ['Alan Turing', 'King\'s College', 'alan@example.test'],
    ['Grace Hopper', 'Vassar College', 'grace@example.test'],
  ]);
  const r = await request(app)
    .post('/api/cert-batches')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      name: 'batch_test_basic',
      templateId,
      file: {
        filename: 'participants.csv',
        contentType: 'text/csv',
        data: Buffer.from(csvData).toString('base64'),
      },
    });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'DRAFT');
  assert.equal(r.body.total_rows, 3);
  assert.deepEqual(r.body.detected_columns_json, ['Full Name', 'Institution', 'Email']);
  assert.equal(r.body.sample_rows_json.length, 3);
  assert.equal(r.body.sample_rows_json[0]['Full Name'], 'Ada Lovelace');
  batchId = r.body.id;
});

test('GET /:id/columns returns detected columns + samples', async () => {
  const r = await request(app)
    .get(`/api/cert-batches/${batchId}/columns`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.columns, ['Full Name', 'Institution', 'Email']);
  assert.equal(r.body.totalRows, 3);
});

test('rejects creation when template has no placeholders', async () => {
  const tpl = await request(app)
    .post('/api/cert-templates')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      name: 'cert_batch_test_no_placeholders',
      image: { filename: 'x.png', contentType: 'image/png', data: PNG_B64 },
    });
  const r = await request(app)
    .post('/api/cert-batches')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      name: 'batch_test_no_ph',
      templateId: tpl.body.id,
      file: {
        filename: 'p.csv',
        contentType: 'text/csv',
        data: Buffer.from('a,b\n1,2').toString('base64'),
      },
    });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no placeholders/i);
});

test('rejects file with no data rows', async () => {
  const r = await request(app)
    .post('/api/cert-batches')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      name: 'batch_test_empty',
      templateId,
      file: {
        filename: 'empty.csv',
        contentType: 'text/csv',
        data: Buffer.from('a,b,c').toString('base64'),
      },
    });
  assert.equal(r.status, 400);
});

test('rejects unsupported file type', async () => {
  const r = await request(app)
    .post('/api/cert-batches')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      name: 'batch_test_unsupported',
      templateId,
      file: {
        filename: 'data.json',
        contentType: 'application/json',
        data: Buffer.from('[]').toString('base64'),
      },
    });
  assert.equal(r.status, 400);
});

test('rejects mapping with missing required placeholder', async () => {
  const r = await request(app)
    .put(`/api/cert-batches/${batchId}/mapping`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      columnMapping: { name: 'Full Name' }, // missing institution
      emailColumn: 'Email',
    });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /institution/);
});

test('rejects mapping referencing unknown column', async () => {
  const r = await request(app)
    .put(`/api/cert-batches/${batchId}/mapping`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      columnMapping: { name: 'Full Name', institution: 'NotAColumn' },
      emailColumn: 'Email',
    });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /NotAColumn/);
});

test('rejects mapping for auto-generated placeholder (serial)', async () => {
  const r = await request(app)
    .put(`/api/cert-batches/${batchId}/mapping`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      columnMapping: {
        name: 'Full Name',
        institution: 'Institution',
        certificate_id: 'Email', // serial — must not be mapped
      },
      emailColumn: 'Email',
    });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /auto-generated/i);
});

test('saves valid mapping and transitions to READY', async () => {
  const r = await request(app)
    .put(`/api/cert-batches/${batchId}/mapping`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      columnMapping: { name: 'Full Name', institution: 'Institution' },
      emailColumn: 'Email',
      nameColumn: 'Full Name',
      serialConfig: { prefix: 'BSERC-2026-', paddingWidth: 5, startAt: 1 },
    });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'READY');
  assert.deepEqual(r.body.column_mapping_json, { name: 'Full Name', institution: 'Institution' });
  assert.equal(r.body.email_column, 'Email');
  assert.equal(r.body.serial_config_json.prefix, 'BSERC-2026-');

  // serial sequence row should exist
  const [rows]: any = await appPool().query(
    'SELECT * FROM cert_serial_sequences WHERE batch_id = ?',
    [batchId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prefix, 'BSERC-2026-');
  assert.equal(rows[0].padding_width, 5);
});

test('mapping is idempotent / re-savable while READY', async () => {
  const r = await request(app)
    .put(`/api/cert-batches/${batchId}/mapping`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      columnMapping: { name: 'Full Name', institution: 'Institution' },
      emailColumn: 'Email',
      serialConfig: { prefix: 'V2-', startAt: 100 },
    });
  assert.equal(r.status, 200);
  assert.equal(r.body.serial_config_json.prefix, 'V2-');
});

test('list batches returns the new batch', async () => {
  const r = await request(app)
    .get(`/api/cert-batches?templateId=${templateId}`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.find((b: any) => b.id === batchId));
});

test('operator cannot delete (admin only)', async () => {
  const r = await request(app)
    .delete(`/api/cert-batches/${batchId}`)
    .set('authorization', `Bearer ${operatorToken}`);
  assert.equal(r.status, 403);
});

test('admin deletes batch', async () => {
  const r = await request(app)
    .delete(`/api/cert-batches/${batchId}`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(r.status, 204);
  const after = await request(app)
    .get(`/api/cert-batches/${batchId}`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(after.status, 404);
});
