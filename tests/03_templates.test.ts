import './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { closeAllPools, appPool } from '../src/db/pools.js';
import { ensureUser, tokenForUser, TEST_ADMIN, TEST_OPERATOR } from './helpers.js';

const app = buildApp();
let adminToken: string;
let operatorToken: string;

before(async () => {
  await ensureUser(TEST_ADMIN);
  await ensureUser(TEST_OPERATOR);
  adminToken = await tokenForUser(TEST_ADMIN.email);
  operatorToken = await tokenForUser(TEST_OPERATOR.email);
  await appPool().query(`DELETE FROM email_templates WHERE template_code LIKE 'test_%'`);
});
after(async () => { await closeAllPools(); });

test('operator creates a template', async () => {
  const r = await request(app)
    .post('/api/templates')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      templateCode: 'test_basic',
      templateName: 'Basic Test',
      subject: 'Hi {{first_name}}',
      htmlBody: '<p>Hello {{first_name}} from {{company_name}}</p>',
    });
  assert.equal(r.status, 201);
  assert.equal(r.body.template_code, 'test_basic');
});

test('duplicate template_code returns 409', async () => {
  const r = await request(app)
    .post('/api/templates')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      templateCode: 'test_basic',
      templateName: 'Dup',
      subject: 'X',
      htmlBody: '<p>x</p>',
    });
  assert.equal(r.status, 409);
});

test('invalid template_code (special chars) returns 400', async () => {
  const r = await request(app)
    .post('/api/templates')
    .set('authorization', `Bearer ${operatorToken}`)
    .send({
      templateCode: 'bad code!',
      templateName: 'X',
      subject: 'X',
      htmlBody: '<p>x</p>',
    });
  assert.equal(r.status, 400);
});

test('list templates returns the new template', async () => {
  const r = await request(app).get('/api/templates').set('authorization', `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.find((t: any) => t.template_code === 'test_basic'));
});

let createdId: number;
test('get template by id', async () => {
  const list = await request(app).get('/api/templates').set('authorization', `Bearer ${adminToken}`);
  createdId = list.body.find((t: any) => t.template_code === 'test_basic').id;
  const r = await request(app).get(`/api/templates/${createdId}`).set('authorization', `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, createdId);
});

test('preview template renders placeholders and reports missing ones', async () => {
  const r = await request(app)
    .post(`/api/templates/${createdId}/preview`)
    .set('authorization', `Bearer ${adminToken}`)
    .send({ vars: { company_name: 'ACME' } });
  assert.equal(r.status, 200);
  assert.match(r.body.subject, /Preview/); // first_name from buildVars defaults to 'Preview'
  assert.match(r.body.htmlBody, /ACME/);
  // first_name and company_name supplied via builtin/buildVars/vars; nothing missing
  assert.deepEqual(r.body.missingPlaceholders, []);
});

test('preview detects missing placeholder', async () => {
  // Insert a template with an unknown placeholder
  const create = await request(app)
    .post('/api/templates')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      templateCode: 'test_missing',
      templateName: 'Missing',
      subject: 'Hi {{nonexistent_var}}',
      htmlBody: '<p>x</p>',
    });
  assert.equal(create.status, 201);
  const r = await request(app)
    .post(`/api/templates/${create.body.id}/preview`)
    .set('authorization', `Bearer ${adminToken}`)
    .send({ vars: {} });
  assert.equal(r.status, 200);
  assert.ok(r.body.missingPlaceholders.includes('nonexistent_var'));
});

test('update template (PUT)', async () => {
  const r = await request(app)
    .put(`/api/templates/${createdId}`)
    .set('authorization', `Bearer ${adminToken}`)
    .send({ templateName: 'Basic Test (Updated)' });
  assert.equal(r.status, 200);
  assert.equal(r.body.template_name, 'Basic Test (Updated)');
});

test('operator cannot delete template (admin only)', async () => {
  const r = await request(app)
    .delete(`/api/templates/${createdId}`)
    .set('authorization', `Bearer ${operatorToken}`);
  assert.equal(r.status, 403);
});

test('admin deletes template', async () => {
  // first create a deletable one
  const create = await request(app)
    .post('/api/templates')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      templateCode: 'test_to_delete',
      templateName: 'X',
      subject: 'X',
      htmlBody: '<p>x</p>',
    });
  const r = await request(app)
    .delete(`/api/templates/${create.body.id}`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(r.status, 204);
});

test('delete non-existent template returns 404', async () => {
  const r = await request(app)
    .delete(`/api/templates/9999999`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(r.status, 404);
});
