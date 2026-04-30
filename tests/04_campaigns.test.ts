import './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { closeAllPools, appPool } from '../src/db/pools.js';
import { ensureUser, tokenForUser, TEST_ADMIN, TEST_OPERATOR } from './helpers.js';
import { __testDrainQueue } from '../src/modules/aws/sqs.service.js';

const app = buildApp();
let adminToken: string;
let operatorToken: string;
let templateId: number;

before(async () => {
  await ensureUser(TEST_ADMIN);
  await ensureUser(TEST_OPERATOR);
  adminToken = await tokenForUser(TEST_ADMIN.email);
  operatorToken = await tokenForUser(TEST_OPERATOR.email);
  await appPool().query(`DELETE FROM campaigns WHERE campaign_name LIKE 'TEST_%'`);
  await appPool().query(`DELETE FROM email_templates WHERE template_code = 'test_camp_tpl'`);
  await appPool().query(`DELETE FROM suppression_list WHERE email LIKE '%@example.test'`);
  const r = await request(app)
    .post('/api/templates')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      templateCode: 'test_camp_tpl',
      templateName: 'Campaign Test Template',
      subject: 'Hello {{first_name}}',
      htmlBody: '<p>Hi {{first_name}} {{last_name}} from {{company_name}}</p>',
    });
  templateId = r.body.id;
  __testDrainQueue();
});

after(async () => { await closeAllPools(); });

test('create campaign from API recipients', async () => {
  const r = await request(app)
    .post('/api/campaigns/send')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      campaignName: 'TEST_API_basic',
      templateId,
      fromEmail: 'test@example.test',
      globalVars: { company_name: 'ACME' },
      recipients: [
        { email: 'one@example.test', firstName: 'One', lastName: 'X' },
        { email: 'two@example.test', firstName: 'Two', lastName: 'Y' },
        { email: 'three@example.test', firstName: 'Three', lastName: 'Z' },
      ],
    });
  assert.equal(r.status, 202);
  assert.ok(r.body.campaignId);
  assert.equal(r.body.stats.inserted, 3);
});

test('campaign deduplicates recipients (case-insensitive)', async () => {
  const r = await request(app)
    .post('/api/campaigns/send')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      campaignName: 'TEST_dedup',
      templateId,
      fromEmail: 'test@example.test',
      recipients: [
        { email: 'dup@example.test', firstName: 'A' },
        { email: 'DUP@example.test', firstName: 'B' },
        { email: 'unique@example.test', firstName: 'C' },
      ],
    });
  assert.equal(r.status, 202);
  assert.equal(r.body.stats.duplicates, 1);
  assert.equal(r.body.stats.inserted, 2);
});

test('campaign rejects invalid email and counts as invalid', async () => {
  const r = await request(app)
    .post('/api/campaigns/send')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      campaignName: 'TEST_invalid',
      templateId,
      fromEmail: 'test@example.test',
      recipients: [
        { email: 'good@example.test' },
        { email: 'not-an-email-format' },
      ],
    });
  // zod validates email format on each recipient before reaching service => 400
  assert.equal(r.status, 400);
});

test('campaign honors suppression list', async () => {
  await request(app)
    .post('/api/suppression')
    .set('authorization', `Bearer ${adminToken}`)
    .send({ email: 'suppressed@example.test', reason: 'MANUAL' });

  const r = await request(app)
    .post('/api/campaigns/send')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      campaignName: 'TEST_suppressed',
      templateId,
      fromEmail: 'test@example.test',
      recipients: [
        { email: 'suppressed@example.test' },
        { email: 'allowed@example.test' },
      ],
    });
  assert.equal(r.status, 202);
  assert.equal(r.body.stats.suppressed, 1);
  assert.equal(r.body.stats.inserted, 1);
});

test('campaign send-from-db rejects non-whitelisted table', async () => {
  const r = await request(app)
    .post('/api/campaigns/send-from-db')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      campaignName: 'TEST_db_bad',
      templateId,
      fromEmail: 'test@example.test',
      tableName: 'sensitive_table',
      emailColumn: 'email',
    });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not whitelisted/i);
});

test('campaign send-from-query disabled by default', async () => {
  const r = await request(app)
    .post('/api/campaigns/send-from-query')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      campaignName: 'TEST_query_disabled',
      templateId,
      fromEmail: 'test@example.test',
      query: 'SELECT email FROM users LIMIT 1',
    });
  assert.equal(r.status, 400);
});

test('pause -> resume -> stats lifecycle', async () => {
  const create = await request(app)
    .post('/api/campaigns/send')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      campaignName: 'TEST_lifecycle',
      templateId,
      fromEmail: 'test@example.test',
      recipients: [{ email: 'lifecycle@example.test' }],
    });
  const id = create.body.campaignId;

  const pause = await request(app)
    .post(`/api/campaigns/${id}/pause`)
    .set('authorization', `Bearer ${operatorToken}`);
  assert.equal(pause.status, 200);
  assert.equal(pause.body.status, 'PAUSED');

  const resume = await request(app)
    .post(`/api/campaigns/${id}/resume`)
    .set('authorization', `Bearer ${operatorToken}`);
  assert.equal(resume.status, 200);
  assert.equal(resume.body.status, 'RUNNING');

  // Cancel requires admin
  const cancelOperator = await request(app)
    .post(`/api/campaigns/${id}/cancel`)
    .set('authorization', `Bearer ${operatorToken}`);
  assert.equal(cancelOperator.status, 403);

  const cancel = await request(app)
    .post(`/api/campaigns/${id}/cancel`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.status, 'CANCELLED');

  // can't resume cancelled
  const resume2 = await request(app)
    .post(`/api/campaigns/${id}/resume`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(resume2.status, 409);

  const stats = await request(app)
    .get(`/api/campaigns/${id}/stats`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.status, 'CANCELLED');
});
