import { appPool } from '../../db/pools.js';
import { conflict, notFound } from '../../common/errors.js';

export interface SenderRow {
  id: number;
  display_name: string;
  email: string;
  reply_to: string | null;
  is_default: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface SenderInput {
  displayName: string;
  email: string;
  replyTo?: string | null;
  isDefault?: boolean;
}

export const listSenders = async (activeOnly = false): Promise<SenderRow[]> => {
  const where = activeOnly ? 'WHERE is_active = 1' : '';
  const [rows]: any = await appPool().query(
    `SELECT * FROM sender_identities ${where} ORDER BY is_default DESC, id DESC`
  );
  return rows as SenderRow[];
};

export const createSender = async (input: SenderInput): Promise<SenderRow> => {
  try {
    if (input.isDefault) {
      await appPool().query('UPDATE sender_identities SET is_default = 0');
    }
    const [r]: any = await appPool().query(
      `INSERT INTO sender_identities (display_name, email, reply_to, is_default) VALUES (?, ?, ?, ?)`,
      [input.displayName, input.email, input.replyTo ?? null, input.isDefault ? 1 : 0]
    );
    const [rows]: any = await appPool().query(
      'SELECT * FROM sender_identities WHERE id = ?',
      [r.insertId]
    );
    return rows[0] as SenderRow;
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') throw conflict('This email is already registered as a sender');
    throw e;
  }
};

export const updateSender = async (
  id: number,
  input: Partial<{
    displayName: string;
    replyTo: string | null;
    isDefault: boolean;
    isActive: boolean;
  }>
): Promise<SenderRow> => {
  const fields: string[] = [];
  const vals: unknown[] = [];

  if (input.displayName !== undefined) {
    fields.push('display_name = ?');
    vals.push(input.displayName);
  }
  if (input.replyTo !== undefined) {
    fields.push('reply_to = ?');
    vals.push(input.replyTo);
  }
  if (input.isActive !== undefined) {
    fields.push('is_active = ?');
    vals.push(input.isActive ? 1 : 0);
  }
  if (input.isDefault) {
    await appPool().query('UPDATE sender_identities SET is_default = 0');
    fields.push('is_default = ?');
    vals.push(1);
  }

  if (!fields.length) {
    const [rows]: any = await appPool().query(
      'SELECT * FROM sender_identities WHERE id = ?',
      [id]
    );
    if (!rows[0]) throw notFound('Sender not found');
    return rows[0] as SenderRow;
  }
  vals.push(id);
  const [r]: any = await appPool().query(
    `UPDATE sender_identities SET ${fields.join(', ')} WHERE id = ?`,
    vals
  );
  if (r.affectedRows === 0) throw notFound('Sender not found');
  const [rows]: any = await appPool().query(
    'SELECT * FROM sender_identities WHERE id = ?',
    [id]
  );
  return rows[0] as SenderRow;
};

export const deleteSender = async (id: number): Promise<void> => {
  const [r]: any = await appPool().query(
    'DELETE FROM sender_identities WHERE id = ?',
    [id]
  );
  if (r.affectedRows === 0) throw notFound('Sender not found');
};
