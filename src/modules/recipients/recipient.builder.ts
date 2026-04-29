import { sourcePool, appPool } from '../../db/pools.js';
import { allowedRecipientTables, env } from '../../config/env.js';
import { badRequest } from '../../common/errors.js';
import { isValidEmail } from '../../common/validate.js';

export interface InboundRecipient {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  data?: Record<string, unknown>;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const checkIdent = (s: string, label: string) => {
  if (!IDENT_RE.test(s)) throw badRequest(`Invalid ${label}: ${s}`);
};

const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|replace|merge|call|set|use|show|describe|explain|lock|unlock|rename)\b/i;

const validateSelectQuery = (raw: string) => {
  const sql = raw.trim().replace(/;\s*$/, '');
  if (!/^select\b/i.test(sql)) throw badRequest('Query must start with SELECT');
  if (sql.includes(';')) throw badRequest('Multiple statements are not allowed');
  if (FORBIDDEN_SQL.test(sql)) throw badRequest('Query contains forbidden keywords');
  if (/\binto\s+outfile\b/i.test(sql) || /\binto\s+dumpfile\b/i.test(sql)) {
    throw badRequest('INTO OUTFILE/DUMPFILE is not allowed');
  }
  return sql;
};

const validateWhere = (where: string) => {
  if (where.includes(';')) throw badRequest('Semicolons not allowed in whereClause');
  if (FORBIDDEN_SQL.test(where)) throw badRequest('whereClause contains forbidden keywords');
  return where;
};

export const fromApi = (recipients: InboundRecipient[]): InboundRecipient[] => {
  if (!recipients?.length) throw badRequest('recipients array is empty');
  return recipients;
};

export const fromTable = async (args: {
  tableName: string;
  emailColumn: string;
  firstNameColumn?: string;
  lastNameColumn?: string;
  whereClause?: string;
  limit?: number;
}): Promise<InboundRecipient[]> => {
  if (!allowedRecipientTables.includes(args.tableName)) {
    throw badRequest(
      `Table "${args.tableName}" is not whitelisted. Allowed: ${allowedRecipientTables.join(', ') || '(none)'}`
    );
  }
  checkIdent(args.tableName, 'tableName');
  checkIdent(args.emailColumn, 'emailColumn');
  if (args.firstNameColumn) checkIdent(args.firstNameColumn, 'firstNameColumn');
  if (args.lastNameColumn) checkIdent(args.lastNameColumn, 'lastNameColumn');
  const where = args.whereClause ? validateWhere(args.whereClause) : '';
  const limit = Math.min(Math.max(args.limit ?? 100000, 1), 500000);

  const cols = [
    `\`${args.emailColumn}\` AS email`,
    args.firstNameColumn ? `\`${args.firstNameColumn}\` AS first_name` : `NULL AS first_name`,
    args.lastNameColumn ? `\`${args.lastNameColumn}\` AS last_name` : `NULL AS last_name`,
  ];
  const sql = `SELECT ${cols.join(', ')} FROM \`${args.tableName}\` ${where ? `WHERE ${where}` : ''} LIMIT ${limit}`;
  const [rows]: any = await sourcePool().query(sql);
  return rows.map((r: any) => ({
    email: String(r.email ?? '').trim(),
    firstName: r.first_name ?? null,
    lastName: r.last_name ?? null,
  }));
};

export const fromQuery = async (rawQuery: string, limit = 100000): Promise<InboundRecipient[]> => {
  if (!env.ALLOW_RAW_QUERY) {
    throw badRequest('Raw query source is disabled (set ALLOW_RAW_QUERY=true to enable)');
  }
  const sql = validateSelectQuery(rawQuery);
  const wrapped = `SELECT * FROM (${sql}) AS _t LIMIT ${Math.min(Math.max(limit, 1), 500000)}`;
  const [rows]: any = await sourcePool().query(wrapped);
  return rows.map((r: any) => {
    const email = r.email ?? r.Email ?? r.EMAIL;
    const firstName = r.first_name ?? r.firstName ?? r.fname ?? null;
    const lastName = r.last_name ?? r.lastName ?? r.lname ?? null;
    const { email: _e, first_name: _f, last_name: _l, firstName: _fn, lastName: _ln, fname: _fa, lname: _la, ...rest } =
      r as Record<string, unknown>;
    return {
      email: String(email ?? '').trim(),
      firstName,
      lastName,
      data: rest,
    } as InboundRecipient;
  });
};

export interface MaterializeStats {
  total: number;
  inserted: number;
  invalid: number;
  duplicates: number;
  suppressed: number;
}

const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

export const materializeRecipients = async (
  campaignId: number,
  raw: InboundRecipient[]
): Promise<MaterializeStats> => {
  const stats: MaterializeStats = { total: raw.length, inserted: 0, invalid: 0, duplicates: 0, suppressed: 0 };

  // dedup by lowercased email; validate
  const byEmail = new Map<string, InboundRecipient>();
  for (const r of raw) {
    const email = (r.email || '').trim().toLowerCase();
    if (!email || !isValidEmail(email)) {
      stats.invalid++;
      continue;
    }
    if (byEmail.has(email)) {
      stats.duplicates++;
      continue;
    }
    byEmail.set(email, { ...r, email });
  }

  // suppression check
  const emails = [...byEmail.keys()];
  if (emails.length) {
    for (const part of chunk(emails, 1000)) {
      const [rows]: any = await appPool().query(
        `SELECT email FROM suppression_list WHERE email IN (${part.map(() => '?').join(',')})`,
        part
      );
      for (const row of rows) {
        byEmail.delete(String(row.email).toLowerCase());
        stats.suppressed++;
      }
    }
  }

  // batch insert
  const list = [...byEmail.values()];
  for (const part of chunk(list, 500)) {
    const values = part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const params: unknown[] = [];
    for (const r of part) {
      params.push(
        campaignId,
        r.email,
        r.firstName ?? null,
        r.lastName ?? null,
        r.data ? JSON.stringify(r.data) : null,
        'PENDING'
      );
    }
    const [res]: any = await appPool().query(
      `INSERT INTO campaign_recipients
         (campaign_id, email, first_name, last_name, payload_json, status)
       VALUES ${values}`,
      params
    );
    stats.inserted += res.affectedRows;
  }

  return stats;
};
