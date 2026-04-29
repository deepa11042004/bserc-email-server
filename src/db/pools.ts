import mysql, { type Pool, type PoolOptions } from 'mysql2/promise';
import { env } from '../config/env.js';

const baseOpts = (): PoolOptions => ({
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0,
  charset: 'utf8mb4',
  dateStrings: false,
  supportBigNumbers: true,
  bigNumberStrings: false,
});

let _appPool: Pool | null = null;
let _sourcePool: Pool | null = null;
let _appPoolNoDb: Pool | null = null;

export const appPool = (): Pool => {
  if (!_appPool) {
    _appPool = mysql.createPool({
      ...baseOpts(),
      host: env.APP_DB_HOST,
      port: env.APP_DB_PORT,
      user: env.APP_DB_USER,
      password: env.APP_DB_PASSWORD,
      database: env.APP_DB_NAME,
      multipleStatements: false,
    });
  }
  return _appPool;
};

// For first-time setup: connect without selecting a database so we can CREATE DATABASE.
export const appPoolNoDb = (): Pool => {
  if (!_appPoolNoDb) {
    _appPoolNoDb = mysql.createPool({
      ...baseOpts(),
      host: env.APP_DB_HOST,
      port: env.APP_DB_PORT,
      user: env.APP_DB_USER,
      password: env.APP_DB_PASSWORD,
      multipleStatements: true,
    });
  }
  return _appPoolNoDb;
};

export const sourcePool = (): Pool => {
  if (!_sourcePool) {
    _sourcePool = mysql.createPool({
      ...baseOpts(),
      host: env.SOURCE_DB_HOST,
      port: env.SOURCE_DB_PORT,
      user: env.SOURCE_DB_USER,
      password: env.SOURCE_DB_PASSWORD,
      database: env.SOURCE_DB_NAME,
    });
  }
  return _sourcePool;
};

export const closeAllPools = async () => {
  await Promise.allSettled([
    _appPool?.end(),
    _appPoolNoDb?.end(),
    _sourcePool?.end(),
  ]);
};
