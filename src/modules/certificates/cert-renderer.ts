import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { badRequest } from '../../common/errors.js';
import type { CertPlaceholderRow, TextAlign } from './cert-templates.types.js';

export interface RenderInput {
  templateImage: { bytes: Buffer; contentType: string; width: number; height: number };
  placeholders: CertPlaceholderRow[];
  /** placeholder_key -> value to draw (already resolved from row + serial + verification code) */
  values: Record<string, string>;
  /** URL to encode in QR (for placeholders where is_qr=1) */
  verificationUrl: string;
}

const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
  const m = /^#?([a-fA-F0-9]{6})$/.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const v = parseInt(m[1]!, 16);
  return { r: ((v >> 16) & 0xff) / 255, g: ((v >> 8) & 0xff) / 255, b: (v & 0xff) / 255 };
};

const pickFont = async (
  doc: PDFDocument,
  family: string,
  weight: 'NORMAL' | 'BOLD'
): Promise<PDFFont> => {
  const fam = family.toLowerCase();
  const bold = weight === 'BOLD';
  if (fam.includes('times')) {
    return doc.embedFont(bold ? StandardFonts.TimesRomanBold : StandardFonts.TimesRoman);
  }
  if (fam.includes('courier')) {
    return doc.embedFont(bold ? StandardFonts.CourierBold : StandardFonts.Courier);
  }
  // default: Helvetica family
  return doc.embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
};

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';

const xForAlign = (xCenter: number, textWidth: number, align: TextAlign): number => {
  if (align === 'LEFT') return xCenter;
  if (align === 'RIGHT') return xCenter - textWidth;
  return xCenter - textWidth / 2;
};

export const renderCertificatePdf = async (input: RenderInput): Promise<Buffer> => {
  const { templateImage, placeholders, values, verificationUrl } = input;
  const doc = await PDFDocument.create();

  // 1px = 1pt — placeholder coordinates map directly to PDF page coords.
  const page = doc.addPage([templateImage.width, templateImage.height]);

  // Embed background image
  const ct = templateImage.contentType.toLowerCase();
  const bytes = templateImage.bytes;
  const bg =
    ct === 'image/jpeg' || ct === 'image/jpg'
      ? await doc.embedJpg(bytes)
      : ct === 'image/png'
        ? await doc.embedPng(bytes)
        : (() => { throw badRequest(`Unsupported template image type: ${ct}`); })();
  page.drawImage(bg, { x: 0, y: 0, width: templateImage.width, height: templateImage.height });

  // Sort placeholders by sort_order for determinism (matters when overlapping)
  const ordered = [...placeholders].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

  for (const p of ordered) {
    if (p.is_qr) {
      const size = p.width || p.height || 96;
      const png = await QRCode.toBuffer(verificationUrl, {
        type: 'png',
        errorCorrectionLevel: 'M',
        margin: 1,
        width: size,
      });
      const img = await doc.embedPng(png);
      // PDF y axis goes bottom-up. Anchor QR at (x, y) treating (x,y) as TOP-LEFT in image space.
      page.drawImage(img, {
        x: p.x,
        y: templateImage.height - p.y - size,
        width: size,
        height: size,
      });
      continue;
    }

    const raw = values[p.placeholder_key] ?? '';
    const text = truncate(String(raw), p.max_length);
    if (!text) continue;

    const font = await pickFont(doc, p.font_family, p.font_weight);
    const size = p.font_size_pt;
    const textWidth = font.widthOfTextAtSize(text, size);
    const ascent = font.heightAtSize(size);
    const { r, g, b } = hexToRgb(p.font_color_hex);

    // (x, y) is the TOP-LEFT of the text bounding box in image pixel space.
    // pdf-lib's drawText anchors at the baseline, so push the baseline down by the
    // font's ascent so that the top of the capital letters sits at y.
    // For CENTER align, treat x as the horizontal center of the text. For LEFT/RIGHT it's the edge.
    const drawX = xForAlign(p.x, textWidth, p.text_align);
    const drawY = templateImage.height - p.y - ascent;

    page.drawText(text, {
      x: drawX,
      y: drawY,
      size,
      font,
      color: rgb(r, g, b),
    });
  }

  const out = await doc.save();
  return Buffer.from(out);
};
