import { randomUUID } from 'node:crypto';
import { appPool } from '../../db/pools.js';
import { badRequest, notFound } from '../../common/errors.js';
import { env } from '../../config/env.js';
import {
  uploadToS3,
  deleteFromS3,
  getPresignedDownloadUrl,
} from '../aws/s3.service.js';
import { probeImage } from './image-dimensions.js';
import type {
  CertPlaceholderRow,
  CertTemplateRow,
  CertTemplateWithUrl,
  CreateCertTemplateInput,
  PlaceholderInput,
  UpdateCertTemplateInput,
} from './cert-templates.types.js';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB

const s3KeyFor = (templateId: number, ext: string) =>
  `cert-templates/${templateId}/${randomUUID()}.${ext}`;

const extFor = (contentType: string): string => {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/jpeg' || contentType === 'image/jpg') return 'jpg';
  throw badRequest('Unsupported image content-type. Use image/png or image/jpeg.');
};

const presignIfPossible = async (key: string): Promise<string> =>
  env.AWS_S3_BUCKET ? getPresignedDownloadUrl(key) : '';

const hydrate = async (
  row: CertTemplateRow,
  withPlaceholders: boolean
): Promise<CertTemplateWithUrl> => {
  const out: CertTemplateWithUrl = {
    ...row,
    image_url: await presignIfPossible(row.image_s3_key),
  };
  if (withPlaceholders) out.placeholders = await listPlaceholders(row.id);
  return out;
};

export const createCertTemplate = async (
  input: CreateCertTemplateInput,
  userId: number
): Promise<CertTemplateWithUrl> => {
  const buf = Buffer.from(input.image.data, 'base64');
  if (buf.byteLength === 0) throw badRequest('Empty image payload');
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw badRequest(`Image exceeds max size of ${MAX_IMAGE_BYTES} bytes`);
  }
  const probed = probeImage(buf);
  // Caller-declared content-type must match what we detected from bytes.
  const declared = input.image.contentType.toLowerCase().replace('image/jpg', 'image/jpeg');
  if (declared !== probed.contentType) {
    throw badRequest(
      `Declared content-type (${input.image.contentType}) does not match file bytes (${probed.contentType})`
    );
  }
  const ext = extFor(probed.contentType);

  // Insert first to obtain id, then upload to S3, then update with s3 key.
  // Using a transaction so a failed upload rolls back the row.
  const conn = await appPool().getConnection();
  try {
    await conn.beginTransaction();
    const [r]: any = await conn.query(
      `INSERT INTO cert_templates
         (name, description, image_s3_key, image_content_type, image_width, image_height,
          image_size_bytes, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      [
        input.name,
        input.description ?? null,
        '', // placeholder, updated after upload
        probed.contentType,
        probed.width,
        probed.height,
        buf.byteLength,
        userId,
      ]
    );
    const id = r.insertId as number;
    const key = s3KeyFor(id, ext);
    await uploadToS3(key, buf, probed.contentType);
    await conn.query('UPDATE cert_templates SET image_s3_key = ? WHERE id = ?', [key, id]);
    await conn.commit();
    return getCertTemplate(id, true);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
};

export const updateCertTemplate = async (
  id: number,
  input: UpdateCertTemplateInput
): Promise<CertTemplateWithUrl> => {
  const fields: string[] = [];
  const vals: unknown[] = [];
  const map: Record<string, string> = {
    name: 'name',
    description: 'description',
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
  if (!fields.length) return getCertTemplate(id, true);
  vals.push(id);
  const [r]: any = await appPool().query(
    `UPDATE cert_templates SET ${fields.join(', ')} WHERE id = ?`,
    vals
  );
  if (r.affectedRows === 0) throw notFound('Certificate template not found');
  return getCertTemplate(id, true);
};

export const getCertTemplate = async (
  id: number,
  withPlaceholders = true
): Promise<CertTemplateWithUrl> => {
  const [rows]: any = await appPool().query(
    'SELECT * FROM cert_templates WHERE id = ? LIMIT 1',
    [id]
  );
  const row = rows[0] as CertTemplateRow | undefined;
  if (!row) throw notFound('Certificate template not found');
  return hydrate(row, withPlaceholders);
};

export const listCertTemplates = async (q: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<CertTemplateWithUrl[]> => {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);
  const where: string[] = [];
  const vals: unknown[] = [];
  if (q.status) {
    where.push('status = ?');
    vals.push(q.status);
  }
  vals.push(limit, offset);
  const [rows]: any = await appPool().query(
    `SELECT * FROM cert_templates
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT ? OFFSET ?`,
    vals
  );
  return Promise.all((rows as CertTemplateRow[]).map((r) => hydrate(r, false)));
};

export const deleteCertTemplate = async (id: number): Promise<void> => {
  const [rows]: any = await appPool().query(
    'SELECT image_s3_key FROM cert_templates WHERE id = ? LIMIT 1',
    [id]
  );
  const row = rows[0] as { image_s3_key: string } | undefined;
  if (!row) throw notFound('Certificate template not found');
  if (row.image_s3_key) {
    try { await deleteFromS3(row.image_s3_key); } catch { /* best-effort */ }
  }
  await appPool().query('DELETE FROM cert_templates WHERE id = ?', [id]);
};

// ----- Placeholders -----

export const listPlaceholders = async (templateId: number): Promise<CertPlaceholderRow[]> => {
  const [rows]: any = await appPool().query(
    `SELECT * FROM cert_placeholders WHERE template_id = ?
       ORDER BY sort_order ASC, id ASC`,
    [templateId]
  );
  return rows as CertPlaceholderRow[];
};

/**
 * Bulk-replace placeholders for a template. Wrapped in a transaction so the
 * placeholder set is always consistent — partial writes can't leave a half-
 * updated layout that the renderer would later draw incorrectly.
 */
export const replacePlaceholders = async (
  templateId: number,
  placeholders: PlaceholderInput[]
): Promise<CertPlaceholderRow[]> => {
  const tpl = await getCertTemplate(templateId, false);
  const keys = new Set<string>();
  for (const p of placeholders) {
    if (!p.placeholderKey || !/^[a-zA-Z0-9_]+$/.test(p.placeholderKey)) {
      throw badRequest(`Invalid placeholder key: ${p.placeholderKey}`);
    }
    if (keys.has(p.placeholderKey)) {
      throw badRequest(`Duplicate placeholder key: ${p.placeholderKey}`);
    }
    keys.add(p.placeholderKey);
    if (p.x < 0 || p.y < 0 || p.x > tpl.image_width || p.y > tpl.image_height) {
      throw badRequest(
        `Placeholder ${p.placeholderKey} position (${p.x},${p.y}) is outside the image (${tpl.image_width}x${tpl.image_height})`
      );
    }
  }

  const conn = await appPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM cert_placeholders WHERE template_id = ?', [templateId]);
    for (let i = 0; i < placeholders.length; i++) {
      const p = placeholders[i]!;
      await conn.query(
        `INSERT INTO cert_placeholders
           (template_id, placeholder_key, x, y, width, height,
            font_family, font_size_pt, font_color_hex, font_weight, text_align,
            is_qr, is_serial, max_length, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          templateId,
          p.placeholderKey,
          p.x,
          p.y,
          p.width ?? 0,
          p.height ?? 0,
          p.fontFamily ?? 'Helvetica',
          p.fontSizePt ?? 18,
          p.fontColorHex ?? '#000000',
          p.fontWeight ?? 'NORMAL',
          p.textAlign ?? 'CENTER',
          p.isQr ? 1 : 0,
          p.isSerial ? 1 : 0,
          p.maxLength ?? 200,
          p.sortOrder ?? i,
        ]
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return listPlaceholders(templateId);
};
