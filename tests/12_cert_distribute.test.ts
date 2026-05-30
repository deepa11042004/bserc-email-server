import './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { closeAllPools, appPool } from '../src/db/pools.js';
import { __testResetS3, uploadToS3 } from '../src/modules/aws/s3.service.js';
import { __testDrainCertQueue } from '../src/modules/certificates/cert-queue.service.js';
import { __testDrainQueue as drainEmailQueue } from '../src/modules/aws/sqs.service.js';
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
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  Buffer.from('IHDR').copy(b, 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const PNG_B64 = buildSyntheticPng(400, 300).toString('base64');

const csv = (rows: string[][]) => rows.map((r) => r.join(',')).join('\n');

let templateId: number;
let batchId: number;
let emailTemplateId: number;

before(async () => {
  await ensureUser(TEST_ADMIN);
  await ensureUser(TEST_OPERATOR);
  adminToken = await tokenForUser(TEST_ADMIN.email);
  operatorToken = await tokenForUser(TEST_OPERATOR.email);
  await appPool().query(`DELETE FROM campaigns WHERE campaign_name LIKE 'TEST_distribute_%' OR campaign_name LIKE 'Certificate Distribution: distribute_test_%'`);
  await appPool().query(`DELETE FROM cert_batches WHERE name LIKE 'distribute_test_%'`);
  await appPool().query(`DELETE FROM cert_templates WHERE name LIKE 'distribute_test_%'`);
  await appPool().query(`DELETE FROM email_templates WHERE template_code = 'test_cert_distribute'`);
  __testResetS3();
  __testDrainCertQueue();
  drainEmailQueue();

  // 1. email template that references cert vars
  const emailTpl = await request(app)
    .post('/api/templates')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      templateCode: 'test_cert_distribute',
      templateName: 'Test Cert Distribution Email',
      subject: 'Your certificate {{certificate_id}} is ready',
      htmlBody:
        '<p>Hi {{first_name}}, your certificate is ready. Verify it at <a href="{{certificate_url}}">{{certificate_url}}</a>.</p>',
    });
  assert.equal(emailTpl.status, 201, JSON.stringify(emailTpl.body));
  emailTemplateId = emailTpl.body.id;

  // 2. cert template + placeholders
  const tpl = await request(app)
    .post('/api/cert-templates')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      name: 'distribute_test_tpl',
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
        { placeholderKey: 'name', x: 200, y: 100, fontSizePt: 18 },
        { placeholderKey: 'serial', x: 50, y: 250, fontSizePt: 10, isSerial: true },
      ],
    });

  // 3. batch with 3 recipients (2 with email, 1 without)
  const data = csv([
    ['name', 'email'],
    ['Ada Lovelace', 'ada@example.test'],
    ['Alan Turing', 'alan@example.test'],
    ['No Email', ''],
  ]);
  const b = await request(app)
    .post('/api/cert-batches')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      name: 'distribute_test_batch',
      templateId,
      file: {
        filename: 'people.csv',
        contentType: 'text/csv',
        data: Buffer.from(data).toString('base64'),
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
      serialConfig: { prefix: 'DIST-', paddingWidth: 3, startAt: 1 },
    });

  // 4. start and wait for materialization
  await request(app)
    .post(`/api/cert-batches/${batchId}/start`)
    .set('authorization', `Bearer ${operatorToken}`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [r]: any = await appPool().query(
      'SELECT COUNT(*) AS n FROM cert_recipients WHERE batch_id = ?',
      [batchId]
    );
    if (Number(r[0].n) >= 3) break;
    await new Promise((res) => setTimeout(res, 30));
  }

  // 5. render all 3 so we have a fully RENDERED batch
  const [recs]: any = await appPool().query(
    `SELECT id FROM cert_recipients WHERE batch_id = ? ORDER BY row_index ASC`,
    [batchId]
  );
  for (const r of recs) await processCertJob(batchId, Number(r.id));

  // Mark batch as RENDERED so distribute() is allowed (worker would do this normally)
  await appPool().query(
    `UPDATE cert_batches SET status = 'RENDERED', completed_at = NOW() WHERE id = ?`,
    [batchId]
  );
});

after(async () => { await closeAllPools(); });

test('rejects distribute on batch that has not finished rendering', async () => {
  // create a sibling DRAFT batch to test status guard
  const csvData = csv([['name', 'email'], ['x', 'x@example.test']]);
  const b = await request(app)
    .post('/api/cert-batches')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      name: 'distribute_test_draft',
      templateId,
      file: {
        filename: 'p.csv',
        contentType: 'text/csv',
        data: Buffer.from(csvData).toString('base64'),
      },
    });
  const r = await request(app)
    .post(`/api/cert-batches/${b.body.id}/distribute`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      emailTemplateId,
      fromEmail: 'noreply@bserc.local',
    });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /RENDERED state/);
});

test('distributes RENDERED batch and creates an email campaign', async () => {
  drainEmailQueue();
  const r = await request(app)
    .post(`/api/cert-batches/${batchId}/distribute`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      emailTemplateId,
      fromEmail: 'noreply@bserc.local',
      replyTo: 'support@bserc.local',
    });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  // Two recipients had emails — the third had blank, must be skipped
  assert.equal(r.body.queuedRecipients, 2);
  assert.ok(r.body.campaignId);

  // Batch must now be linked to the campaign and DISTRIBUTING
  const [rows]: any = await appPool().query(
    'SELECT status, email_campaign_id, sent_count FROM cert_batches WHERE id = ?',
    [batchId]
  );
  assert.equal(rows[0].status, 'DISTRIBUTING');
  assert.equal(Number(rows[0].email_campaign_id), Number(r.body.campaignId));
  assert.equal(Number(rows[0].sent_count), 2);

  // cert_recipients with email moved to SENT, the one without stays RENDERED
  const [recs]: any = await appPool().query(
    `SELECT email, status FROM cert_recipients WHERE batch_id = ?`,
    [batchId]
  );
  const byEmail = Object.fromEntries(recs.map((r: any) => [r.email || '<blank>', r.status]));
  assert.equal(byEmail['ada@example.test'], 'SENT');
  assert.equal(byEmail['alan@example.test'], 'SENT');
  assert.equal(byEmail['<blank>'], 'RENDERED');

  // Campaign recipients must have certificate_url in payload (verify URL)
  const [campRecs]: any = await appPool().query(
    `SELECT email, payload_json FROM campaign_recipients WHERE campaign_id = ? ORDER BY email`,
    [r.body.campaignId]
  );
  assert.equal(campRecs.length, 2);
  for (const cr of campRecs) {
    const payload = typeof cr.payload_json === 'string' ? JSON.parse(cr.payload_json) : cr.payload_json;
    assert.match(payload.certificate_url, /\/verify\//);
    assert.match(payload.certificate_id, /^DIST-\d{3}$/);
    assert.ok(payload.recipient_name);
  }
});

test('rejects re-distribute on a batch already linked to a campaign', async () => {
  const r = await request(app)
    .post(`/api/cert-batches/${batchId}/distribute`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      emailTemplateId,
      fromEmail: 'noreply@bserc.local',
    });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already has an email campaign/i);
});

test('rejects distribute when no recipients have valid email', async () => {
  // batch with only invalid emails
  const csvData = csv([['name', 'email'], ['Bob', 'not-an-email']]);
  const b = await request(app)
    .post('/api/cert-batches')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      name: 'distribute_test_invalid_emails',
      templateId,
      file: {
        filename: 'p.csv',
        contentType: 'text/csv',
        data: Buffer.from(csvData).toString('base64'),
      },
    });
  await request(app)
    .put(`/api/cert-batches/${b.body.id}/mapping`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      columnMapping: { name: 'name' },
      emailColumn: 'email',
      nameColumn: 'name',
    });
  await appPool().query(
    `INSERT INTO cert_recipients (batch_id, row_index, serial_no, verification_code, email, full_name, row_data_json, status, cert_s3_key, rendered_at)
     VALUES (?, 0, 'X-001', 'invalid_email_test_code__', 'not-an-email', 'Bob', ?, 'RENDERED', 'certs/x/x.pdf', NOW())`,
    [b.body.id, JSON.stringify({ name: 'Bob', email: 'not-an-email' })]
  );
  await appPool().query(`UPDATE cert_batches SET status = 'RENDERED' WHERE id = ?`, [b.body.id]);

  const r = await request(app)
    .post(`/api/cert-batches/${b.body.id}/distribute`)
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      emailTemplateId,
      fromEmail: 'noreply@bserc.local',
    });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no rendered recipients/i);
});
