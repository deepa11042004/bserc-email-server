import { appPool } from '../../db/pools.js';
import { conflict, notFound } from '../../common/errors.js';

export interface TemplateInput {
  templateCode: string;
  templateName: string;
  subject: string;
  htmlBody: string;
  textBody?: string | null;
  status?: 'ACTIVE' | 'DISABLED';
}

export interface TemplateRow {
  id: number;
  template_code: string;
  template_name: string;
  subject: string;
  html_body: string;
  text_body: string | null;
  status: 'ACTIVE' | 'DISABLED';
  created_at: Date;
  updated_at: Date;
}

export const createTemplate = async (input: TemplateInput, userId: number) => {
  try {
    const [r]: any = await appPool().query(
      `INSERT INTO email_templates
         (template_code, template_name, subject, html_body, text_body, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.templateCode,
        input.templateName,
        input.subject,
        input.htmlBody,
        input.textBody ?? null,
        input.status ?? 'ACTIVE',
        userId,
      ]
    );
    return await getTemplate(r.insertId);
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') throw conflict('Template code already exists');
    throw e;
  }
};

export const updateTemplate = async (id: number, input: Partial<TemplateInput>) => {
  const fields: string[] = [];
  const vals: unknown[] = [];
  const map: Record<string, string> = {
    templateCode: 'template_code',
    templateName: 'template_name',
    subject: 'subject',
    htmlBody: 'html_body',
    textBody: 'text_body',
    status: 'status',
  };
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    const col = map[k];
    if (col) {
      fields.push(`${col} = ?`);
      vals.push(v);
    }
  }
  if (!fields.length) return getTemplate(id);
  vals.push(id);
  const [r]: any = await appPool().query(
    `UPDATE email_templates SET ${fields.join(', ')} WHERE id = ?`,
    vals
  );
  if (r.affectedRows === 0) throw notFound('Template not found');
  return getTemplate(id);
};

export const getTemplate = async (id: number): Promise<TemplateRow> => {
  const [rows]: any = await appPool().query(
    'SELECT * FROM email_templates WHERE id = ? LIMIT 1',
    [id]
  );
  const row = rows[0];
  if (!row) throw notFound('Template not found');
  return row;
};

export const getTemplateByCode = async (code: string): Promise<TemplateRow> => {
  const [rows]: any = await appPool().query(
    'SELECT * FROM email_templates WHERE template_code = ? LIMIT 1',
    [code]
  );
  const row = rows[0];
  if (!row) throw notFound('Template not found');
  return row;
};

export const listTemplates = async (q: { status?: string; limit?: number; offset?: number }) => {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);
  const where: string[] = [];
  const vals: unknown[] = [];
  if (q.status) {
    where.push('status = ?');
    vals.push(q.status);
  }
  const sql = `SELECT id, template_code, template_name, subject, status, created_at, updated_at
    FROM email_templates
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id DESC LIMIT ? OFFSET ?`;
  vals.push(limit, offset);
  const [rows]: any = await appPool().query(sql, vals);
  return rows;
};

export const deleteTemplate = async (id: number) => {
  const [r]: any = await appPool().query('DELETE FROM email_templates WHERE id = ?', [id]);
  if (r.affectedRows === 0) throw notFound('Template not found');
};
