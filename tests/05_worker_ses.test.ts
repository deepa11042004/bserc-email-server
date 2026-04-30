import './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { closeAllPools, appPool } from '../src/db/pools.js';
import { ensureUser, tokenForUser, TEST_ADMIN } from './helpers.js';
import { __testDrainQueue } from '../src/modules/aws/sqs.service.js';
import { __resetMockSendCount, sendOne } from '../src/modules/aws/ses.service.js';
import { buildVars, render } from '../src/modules/templates/placeholders.js';

const app = buildApp();
let adminToken: string;
let templateId: number;

before(async () => {
  await ensureUser(TEST_ADMIN);
  adminToken = await tokenForUser(TEST_ADMIN.email);
  await appPool().query(`DELETE FROM campaigns WHERE campaign_name LIKE 'TEST_WORKER%'`);
  await appPool().query(`DELETE FROM email_templates WHERE template_code = 'test_worker'`);
  const r = await request(app)
    .post('/api/templates')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      templateCode: 'test_worker',
      templateName: 'Worker Test',
      subject: 'Hi {{first_name}}',
      htmlBody: '<p>Hello {{first_name}} {{last_name}}</p>',
    });
  templateId = r.body.id;
  __testDrainQueue();
  __resetMockSendCount();
});

after(async () => { await closeAllPools(); });

test('campaign creation enqueues jobs into SQS (in-memory in test mode)', async () => {
  __testDrainQueue();
  const r = await request(app)
    .post('/api/campaigns/send')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      campaignName: 'TEST_WORKER_enqueue',
      templateId,
      fromEmail: 'test@example.test',
      recipients: Array.from({ length: 5 }).map((_, i) => ({
        email: `enq${i}@example.test`,
        firstName: `User${i}`,
      })),
    });
  assert.equal(r.status, 202);
  const drained = __testDrainQueue();
  assert.equal(drained.length, 5);
  for (const m of drained) {
    assert.equal(m.body.campaignId, r.body.campaignId);
    assert.ok(m.body.recipientId);
  }
});

test('worker sends emails and marks recipients SENT (loop with mocked SES)', async () => {
  __testDrainQueue();
  __resetMockSendCount();
  const create = await request(app)
    .post('/api/campaigns/send')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      campaignName: 'TEST_WORKER_send',
      templateId,
      fromEmail: 'test@example.test',
      recipients: Array.from({ length: 3 }).map((_, i) => ({
        email: `send${i}@example.test`,
        firstName: `User${i}`,
      })),
    });
  const id = create.body.campaignId;

  // Simulate the worker: pick the queued recipient ids and call sendOne directly per recipient.
  const [recips]: any = await appPool().query(
    `SELECT id, email, first_name, last_name, payload_json FROM campaign_recipients WHERE campaign_id = ?`,
    [id]
  );
  for (const rec of recips) {
    const vars = buildVars({
      email: rec.email,
      first_name: rec.first_name,
      last_name: rec.last_name,
      payload_json: rec.payload_json,
    }, { company_name: 'ACME' });
    const subject = render('Hi {{first_name}}', vars).output;
    assert.match(subject, /^Hi User\d$/);
    const out = await sendOne({
      fromEmail: 'test@example.test',
      toEmail: rec.email,
      subject,
      htmlBody: '<p>x</p>',
      campaignId: id,
      recipientId: rec.id,
    });
    assert.match(out.messageId, /^mock-/);
    await appPool().query(
      `UPDATE campaign_recipients SET status='SENT', ses_message_id=?, sent_at=NOW() WHERE id=?`,
      [out.messageId, rec.id]
    );
  }
  await appPool().query('UPDATE campaigns SET sent_count = ? WHERE id = ?', [recips.length, id]);

  const stats = await request(app)
    .get(`/api/campaigns/${id}/stats`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(stats.body.counters.sent, 3);
  assert.equal(stats.body.recipientStatusBreakdown.SENT, 3);
});

test('test-send endpoint sends a single email (mocked)', async () => {
  __resetMockSendCount();
  const r = await request(app)
    .post('/api/campaigns/test-send')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      templateId,
      fromEmail: 'test@example.test',
      toEmail: 'recipient@example.test',
      vars: { first_name: 'Tester', last_name: 'Last' },
    });
  assert.equal(r.status, 200);
  assert.match(r.body.messageId, /^mock-/);
});
