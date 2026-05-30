import { badRequest } from '../../common/errors.js';

export interface ImageInfo {
  width: number;
  height: number;
  contentType: 'image/png' | 'image/jpeg';
}

const isPng = (b: Buffer) =>
  b.length >= 24 &&
  b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
  b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;

const isJpeg = (b: Buffer) => b.length >= 4 && b[0] === 0xff && b[1] === 0xd8;

const parsePng = (b: Buffer): ImageInfo => {
  // IHDR chunk starts at byte 8, width at 16, height at 20 (big-endian uint32)
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (!width || !height) throw badRequest('Invalid PNG: zero dimensions');
  return { width, height, contentType: 'image/png' };
};

const parseJpeg = (b: Buffer): ImageInfo => {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw badRequest('Invalid JPEG marker');
    let marker = b[i + 1]!;
    // Skip fill bytes
    while (marker === 0xff) {
      i++;
      marker = b[i + 1]!;
    }
    i += 2;
    // SOF markers carry image dimensions (excluding DHT 0xC4, JPG 0xC8, DAC 0xCC)
    if (
      (marker >= 0xc0 && marker <= 0xcf) &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      const height = b.readUInt16BE(i + 3);
      const width = b.readUInt16BE(i + 5);
      if (!width || !height) throw badRequest('Invalid JPEG: zero dimensions');
      return { width, height, contentType: 'image/jpeg' };
    }
    const segLen = b.readUInt16BE(i);
    i += segLen;
  }
  throw badRequest('Invalid JPEG: SOF marker not found');
};

export const probeImage = (buffer: Buffer): ImageInfo => {
  if (isPng(buffer)) return parsePng(buffer);
  if (isJpeg(buffer)) return parseJpeg(buffer);
  throw badRequest('Unsupported image format. Use PNG or JPEG.');
};
