import './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { closeAllPools } from '../src/db/pools.js';
import { ensureUser, tokenForUser, TEST_ADMIN, TEST_VIEWER } from './helpers.js';

const app = buildApp();

before(async () => {
  await ensureUser(TEST_ADMIN);
  await ensureUser(TEST_VIEWER);
});
after(async () => { await closeAllPools(); });

test('login with bad password returns 401', async () => {
  const r = await request(app)
    .post('/api/auth/login')
    .send({ email: TEST_ADMIN.email, password: 'wrong' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Invalid credentials');
});

test('login with malformed email returns 400', async () => {
  const r = await request(app)
    .post('/api/auth/login')
    .send({ email: 'not-an-email', password: 'whatever' });
  assert.equal(r.status, 400);
});

test('login with non-existent user returns 401 (does not leak existence)', async () => {
  const r = await request(app)
    .post('/api/auth/login')
    .send({ email: 'nonexistent@example.test', password: 'whatever' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Invalid credentials');
});

test('login with correct credentials returns JWT', async () => {
  const r = await request(app)
    .post('/api/auth/login')
    .send({ email: TEST_ADMIN.email, password: TEST_ADMIN.password });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.equal(r.body.user.role, 'ADMIN');
});

test('protected endpoint without token returns 401', async () => {
  const r = await request(app).get('/api/templates');
  assert.equal(r.status, 401);
});

test('protected endpoint with malformed Bearer returns 401', async () => {
  const r = await request(app).get('/api/templates').set('authorization', 'Token abc');
  assert.equal(r.status, 401);
});

test('protected endpoint with invalid JWT returns 401', async () => {
  const r = await request(app).get('/api/templates').set('authorization', 'Bearer not.a.real.jwt');
  assert.equal(r.status, 401);
});

test('viewer cannot create templates (403)', async () => {
  const tok = await tokenForUser(TEST_VIEWER.email);
  const r = await request(app)
    .post('/api/templates')
    .set('authorization', `Bearer ${tok}`)
    .send({
      templateCode: 'test_unauthorized',
      templateName: 'X',
      subject: 'X',
      htmlBody: '<p>x</p>',
    });
  assert.equal(r.status, 403);
});

test('admin can list templates', async () => {
  const tok = await tokenForUser(TEST_ADMIN.email);
  const r = await request(app).get('/api/templates').set('authorization', `Bearer ${tok}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
});
