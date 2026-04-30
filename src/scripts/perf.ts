/**
 * Perf harness — runs in-process against the Express app (no port).
 * Three benchmarks:
 *  1. API concurrency: 100 concurrent /health requests
 *  2. Campaign creation: one campaign with 5000 recipients (TEST_NO_AWS=true to skip real SES)
 *  3. Render throughput: 100k placeholder renders, no I/O
 *  4. Memory growth: 5 iterations of #2; report RSS delta
 */
process.env.NODE_ENV = 'test';
process.env.TEST_NO_AWS = 'true';
process.env.SQS_QUEUE_URL = process.env.SQS_QUEUE_URL || 'https://sqs.local/fake/queue';
process.env.LOG_LEVEL = 'error';

import 'dotenv/config';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { buildApp } from '../app.js';
import { appPool, closeAllPools } from '../db/pools.js';
import { env } from '../config/env.js';
import { __testDrainQueue } from '../modules/aws/sqs.service.js';
import { render, buildVars } from '../modules/templates/placeholders.js';

const app = buildApp();

const fmt = (ms: number) => `${ms.toFixed(2)} ms`;
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

async function ensurePerfUser() {
  const pool = appPool();
  const hash = await bcrypt.hash('PerfPass!', 4);
  await pool.query(
    `INSERT INTO users (email, password_hash, name, role, is_active) VALUES ('perf@bserc.local', ?, 'Perf', 'ADMIN', 1)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), is_active = 1`,
    [hash]
  );
  const [rows]: any = await pool.query("SELECT id, email, role FROM users WHERE email = 'perf@bserc.local'");
  return jwt.sign({ id: rows[0].id, email: rows[0].email, role: rows[0].role }, env.JWT_SECRET, {
    expiresIn: '1h',
  });
}

async function ensureTemplate(token: string): Promise<number> {
  await appPool().query(`DELETE FROM email_templates WHERE template_code = 'perf_tpl'`);
  const r = await request(app)
    .post('/api/templates')
    .set('authorization', `Bearer ${token}`)
    .send({
      templateCode: 'perf_tpl',
      templateName: 'Perf',
      subject: 'Hi {{first_name}}',
      htmlBody: '<p>Hello {{first_name}} {{last_name}} from {{company_name}}</p>',
    });
  return r.body.id;
}

async function bench1_apiConcurrency() {
  console.log('\n[1/4] API concurrency: 100 concurrent /health requests');
  const N = 100;
  const t0 = performance.now();
  const tasks = Array.from({ length: N }).map(() => request(app).get('/health').expect(200));
  await Promise.all(tasks);
  const elapsed = performance.now() - t0;
  console.log(`  total ${fmt(elapsed)}, avg ${fmt(elapsed / N)}, throughput ${(N / (elapsed / 1000)).toFixed(0)} req/s`);
}

async function bench2_campaign5k(token: string, templateId: number, label = '') {
  const N = 5000;
  console.log(`\n[2/4] Campaign create with ${N} recipients ${label}`);
  await appPool().query(`DELETE FROM campaigns WHERE campaign_name LIKE 'PERF_%'`);
  __testDrainQueue();
  const recipients = Array.from({ length: N }).map((_, i) => ({
    email: `perf${i}@example.test`,
    firstName: `User${i}`,
    lastName: `Last${i}`,
  }));
  const t0 = performance.now();
  const r = await request(app)
    .post('/api/campaigns/send')
    .set('authorization', `Bearer ${token}`)
    .send({
      campaignName: `PERF_${Date.now()}`,
      templateId,
      fromEmail: 'perf@example.test',
      globalVars: { company_name: 'ACME' },
      recipients,
    });
  const elapsed = performance.now() - t0;
  if (r.status !== 202) {
    console.log('  FAIL', r.status, r.body);
    return;
  }
  const drained = __testDrainQueue();
  console.log(
    `  inserted=${r.body.stats.inserted}, queued=${drained.length}, total=${fmt(elapsed)}, ` +
      `${(r.body.stats.inserted / (elapsed / 1000)).toFixed(0)} recipients/s`
  );
  return r.body.campaignId as number;
}

function bench3_render() {
  console.log('\n[3/4] Render throughput (placeholder engine)');
  const tpl =
    'Hello {{first_name}} {{last_name}} from {{company_name}} on {{today_date}}, year {{current_year}}.';
  const recipient = {
    email: 'x@example.test',
    first_name: 'First',
    last_name: 'Last',
    payload_json: { company_name: 'ACME' },
  };
  const N = 100_000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    render(tpl, buildVars(recipient));
  }
  const elapsed = performance.now() - t0;
  console.log(`  ${N} renders in ${fmt(elapsed)} = ${(N / (elapsed / 1000)).toFixed(0)} renders/s`);
}

async function bench4_memory(token: string, templateId: number) {
  console.log('\n[4/4] Memory pressure: 5 iterations of 5k campaign');
  if (global.gc) global.gc();
  const before = process.memoryUsage();
  for (let i = 0; i < 5; i++) {
    await bench2_campaign5k(token, templateId, `(iter ${i + 1})`);
  }
  if (global.gc) global.gc();
  const after = process.memoryUsage();
  console.log(
    `  RSS    ${mb(before.rss)} -> ${mb(after.rss)} (delta ${mb(after.rss - before.rss)})`
  );
  console.log(
    `  Heap   ${mb(before.heapUsed)} -> ${mb(after.heapUsed)} (delta ${mb(after.heapUsed - before.heapUsed)})`
  );
}

async function main() {
  console.log('=== BSERC Email Server — perf benchmark ===');
  const token = await ensurePerfUser();
  const templateId = await ensureTemplate(token);

  await bench1_apiConcurrency();
  await bench2_campaign5k(token, templateId);
  bench3_render();
  await bench4_memory(token, templateId);

  console.log('\nDone.');
}

main()
  .catch((e) => {
    console.error('perf failed', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await appPool().query(`DELETE FROM campaigns WHERE campaign_name LIKE 'PERF_%'`);
    await appPool().query(`DELETE FROM email_templates WHERE template_code = 'perf_tpl'`);
    await appPool().query(`DELETE FROM users WHERE email = 'perf@bserc.local'`);
    await closeAllPools();
  });
