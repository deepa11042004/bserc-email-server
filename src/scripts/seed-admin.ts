import bcrypt from 'bcryptjs';
import { appPool, closeAllPools } from '../db/pools.js';
import { logger } from '../common/logger.js';

const email = process.env.ADMIN_EMAIL || 'admin@bserc.local';
const password = process.env.ADMIN_PASSWORD || 'ChangeMe!2026';
const name = process.env.ADMIN_NAME || 'Admin';

async function main() {
  const pool = appPool();
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (email, password_hash, name, role, is_active)
     VALUES (?, ?, ?, 'ADMIN', 1)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), name = VALUES(name), role = 'ADMIN', is_active = 1`,
    [email, hash, name]
  );
  logger.info({ email }, 'Admin user upserted (password from $ADMIN_PASSWORD or default)');
}

main()
  .catch((e) => {
    logger.error({ err: e }, 'Seed admin failed');
    process.exitCode = 1;
  })
  .finally(closeAllPools);
