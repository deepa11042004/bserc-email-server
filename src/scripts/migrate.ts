import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { logger } from '../common/logger.js';
import { appPool, appPoolNoDb, closeAllPools } from '../db/pools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = join(__dirname, '..', 'db', 'migrations');

async function ensureDatabase() {
  const pool = appPoolNoDb();
  const dbName = env.APP_DB_NAME.replace(/`/g, '');
  await pool.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  logger.info({ db: dbName }, 'Ensured app database exists');
}

async function ensureMigrationsTable() {
  const pool = appPool();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id INT NOT NULL,
       filename VARCHAR(255) NOT NULL,
       applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

async function appliedIds(): Promise<Set<number>> {
  const pool = appPool();
  const [rows] = await pool.query<any[]>('SELECT id FROM schema_migrations');
  return new Set(rows.map((r) => Number(r.id)));
}

function listMigrationFiles(): { id: number; file: string }[] {
  return readdirSync(MIG_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((file) => ({ id: parseInt(file.split('_', 1)[0]!, 10), file }))
    .sort((a, b) => a.id - b.id);
}

function splitStatements(sql: string): string[] {
  // Strip line comments, then split on `;` at statement end. Adequate for our DDL files.
  const cleaned = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  return cleaned
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function applyMigration(id: number, file: string) {
  const sql = readFileSync(join(MIG_DIR, file), 'utf8');
  const stmts = splitStatements(sql);
  const conn = await appPool().getConnection();
  try {
    await conn.beginTransaction();
    for (const s of stmts) await conn.query(s);
    await conn.query('INSERT INTO schema_migrations (id, filename) VALUES (?, ?)', [id, file]);
    await conn.commit();
    logger.info({ id, file }, 'Applied migration');
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function main() {
  await ensureDatabase();
  await ensureMigrationsTable();
  const applied = await appliedIds();
  const files = listMigrationFiles();
  let n = 0;
  for (const { id, file } of files) {
    if (applied.has(id)) continue;
    await applyMigration(id, file);
    n++;
  }
  logger.info({ applied: n, total: files.length }, 'Migrations complete');
}

main()
  .catch((e) => {
    logger.error({ err: e }, 'Migration failed');
    process.exitCode = 1;
  })
  .finally(closeAllPools);
