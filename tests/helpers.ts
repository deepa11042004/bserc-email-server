import 'dotenv/config';
process.env.NODE_ENV = 'test';
process.env.TEST_NO_AWS = 'true';
process.env.SQS_QUEUE_URL = process.env.SQS_QUEUE_URL || 'https://sqs.local/fake/queue';
process.env.LOG_LEVEL = process.env.LOG_LEVEL_TEST || 'error';

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { appPool } from '../src/db/pools.js';
import { env } from '../src/config/env.js';

export const TEST_TAG = 'TEST_RUN';

export const TEST_ADMIN = { email: 'admin-test@bserc.local', password: 'TestPass!2026', role: 'ADMIN' as const };
export const TEST_OPERATOR = { email: 'operator-test@bserc.local', password: 'TestPass!2026', role: 'OPERATOR' as const };
export const TEST_VIEWER = { email: 'viewer-test@bserc.local', password: 'TestPass!2026', role: 'VIEWER' as const };

export const ensureUser = async (u: { email: string; password: string; role: 'ADMIN' | 'OPERATOR' | 'VIEWER' }) => {
  const hash = await bcrypt.hash(u.password, 4);
  await appPool().query(
    `INSERT INTO users (email, password_hash, name, role, is_active)
     VALUES (?, ?, 'Test', ?, 1)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = VALUES(role), is_active = 1`,
    [u.email, hash, u.role]
  );
};

export const tokenFor = (u: { email: string; role: 'ADMIN' | 'OPERATOR' | 'VIEWER' }) => {
  // Look up user id from DB synchronously? Use jwt-only payload — backend validates by sig, not lookup.
  return null;
};

export const tokenForUser = async (email: string) => {
  const [rows]: any = await appPool().query('SELECT id, email, role FROM users WHERE email = ?', [email]);
  const u = rows[0];
  return jwt.sign({ id: u.id, email: u.email, role: u.role }, env.JWT_SECRET, { expiresIn: '1h' });
};

export const cleanupTestData = async () => {
  const pool = appPool();
  await pool.query(`DELETE FROM email_events WHERE email LIKE '%@example.test'`);
  await pool.query(
    `DELETE FROM campaign_recipients WHERE campaign_id IN
       (SELECT id FROM campaigns WHERE campaign_name LIKE 'TEST_%')`
  );
  await pool.query(`DELETE FROM campaigns WHERE campaign_name LIKE 'TEST_%'`);
  await pool.query(`DELETE FROM email_templates WHERE template_code LIKE 'test_%'`);
  await pool.query(`DELETE FROM suppression_list WHERE email LIKE '%@example.test'`);
  await pool.query(`DELETE FROM users WHERE email LIKE '%-test@bserc.local'`);
};

export const setupAll = async () => {
  await cleanupTestData();
  await ensureUser(TEST_ADMIN);
  await ensureUser(TEST_OPERATOR);
  await ensureUser(TEST_VIEWER);
};
