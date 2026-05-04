import { randomUUID } from 'node:crypto';
import { appPool } from '../../db/pools.js';
import { conflict, notFound } from '../../common/errors.js';
import { uploadToS3, deleteFromS3, getPresignedDownloadUrl } from '../aws/s3.service.js';
import { env } from '../../config/env.js';

export interface TemplateInput {
  templateCode: string;
  templateName: string;
  subject: string;
  htmlBody: string;
  textBody?: string | null;
  status?: 'ACTIVE' | 'DISABLED';
}

export interface AttachmentRow {
  id: number;
  template_id: number;
  filename: string;
  s3_key: string;
  content_type: string;
  size_bytes: number;
  created_at: Date;
}

export interface AttachmentRowWithUrl extends AttachmentRow {
  download_url: string;
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
  attachments?: AttachmentRowWithUrl[];
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

export const getTemplate = async (id: number, withAttachments = true): Promise<TemplateRow> => {
  const [rows]: any = await appPool().query(
    'SELECT * FROM email_templates WHERE id = ? LIMIT 1',
    [id]
  );
  const row = rows[0];
  if (!row) throw notFound('Template not found');
  if (withAttachments) {
    row.attachments = await listTemplateAttachments(id, true);
  }
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
  // Load attachments first to clean up S3
  const attachments = await listTemplateAttachments(id, false);
  for (const att of attachments) {
    try { await deleteFromS3(att.s3_key); } catch { /* best-effort */ }
  }
  const [r]: any = await appPool().query('DELETE FROM email_templates WHERE id = ?', [id]);
  if (r.affectedRows === 0) throw notFound('Template not found');
};

// ----- Attachments -----

export const listTemplateAttachments = async (
  templateId: number,
  withUrls = true
): Promise<AttachmentRowWithUrl[]> => {
  const [rows]: any = await appPool().query(
    'SELECT * FROM template_attachments WHERE template_id = ? ORDER BY id',
    [templateId]
  );
  return Promise.all(
    (rows as AttachmentRow[]).map(async (r) => ({
      ...r,
      download_url: withUrls && env.AWS_S3_BUCKET
        ? await getPresignedDownloadUrl(r.s3_key)
        : '',
    }))
  );
};

export interface AddAttachmentInput {
  filename: string;
  contentType: string;
  data: string; // base64-encoded file content
}

export const addAttachment = async (
  templateId: number,
  input: AddAttachmentInput
): Promise<AttachmentRowWithUrl> => {
  // Ensure template exists
  await getTemplate(templateId, false);

  const fileBuffer = Buffer.from(input.data, 'base64');
  const safeFilename = input.filename.replace(/[^a-zA-Z0-9._\-]/g, '_');
  const s3Key = `email-templates/${templateId}/${randomUUID()}/${safeFilename}`;

  await uploadToS3(s3Key, fileBuffer, input.contentType);

  const [r]: any = await appPool().query(
    `INSERT INTO template_attachments (template_id, filename, s3_key, content_type, size_bytes)
     VALUES (?, ?, ?, ?, ?)`,
    [templateId, safeFilename, s3Key, input.contentType, fileBuffer.byteLength]
  );

  const [rows]: any = await appPool().query(
    'SELECT * FROM template_attachments WHERE id = ?',
    [r.insertId]
  );
  const row = rows[0] as AttachmentRow;
  return {
    ...row,
    download_url: await getPresignedDownloadUrl(s3Key),
  };
};

export const removeAttachment = async (
  templateId: number,
  attachmentId: number
): Promise<void> => {
  const [rows]: any = await appPool().query(
    'SELECT * FROM template_attachments WHERE id = ? AND template_id = ? LIMIT 1',
    [attachmentId, templateId]
  );
  const row = rows[0] as AttachmentRow | undefined;
  if (!row) throw notFound('Attachment not found');

  try { await deleteFromS3(row.s3_key); } catch { /* best-effort */ }

  await appPool().query('DELETE FROM template_attachments WHERE id = ?', [attachmentId]);
};
