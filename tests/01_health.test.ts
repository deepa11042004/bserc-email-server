import './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { closeAllPools } from '../src/db/pools.js';

const app = buildApp();

before(async () => {});
after(async () => { await closeAllPools(); });

test('GET /live returns ok', async () => {
  const r = await request(app).get('/live');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
  assert.ok(typeof r.body.uptime === 'number');
});

test('GET /ready returns ready when DB reachable', async () => {
  const r = await request(app).get('/ready');
  assert.equal(r.status, 200);
  assert.equal(r.body.db, 'ok');
});

test('GET /health returns ok', async () => {
  const r = await request(app).get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.service, 'email-server');
});

test('GET /api-docs.json exposes OpenAPI spec', async () => {
  const r = await request(app).get('/api-docs.json');
  assert.equal(r.status, 200);
  assert.equal(r.body.openapi, '3.0.3');
  assert.ok(r.body.paths['/api/campaigns/send']);
});

test('GET /swagger renders Swagger UI', async () => {
  const r = await request(app).get('/swagger/').redirects(1);
  assert.equal(r.status, 200);
  assert.match(r.text, /swagger-ui/i);
});
