import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { badRequest } from '../../common/errors.js';

export interface ParsedSpreadsheet {
  columns: string[];
  rowCount: number;
  sampleRows: Record<string, string>[]; // first N data rows (string values)
}

export type SpreadsheetFormat = 'csv' | 'xlsx';

const SAMPLE_SIZE = 5;

const sniffFormat = (filename: string, contentType: string): SpreadsheetFormat => {
  const ct = contentType.toLowerCase();
  const lname = filename.toLowerCase();
  if (
    ct === 'text/csv' ||
    ct === 'application/csv' ||
    ct === 'text/plain' ||
    lname.endsWith('.csv')
  ) return 'csv';
  if (
    ct === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    ct === 'application/vnd.ms-excel' ||
    lname.endsWith('.xlsx') ||
    lname.endsWith('.xls')
  ) return 'xlsx';
  throw badRequest(
    `Unsupported file type. Use .csv, .xlsx, or .xls (got "${contentType}" / "${filename}")`
  );
};

const normalizeHeader = (raw: unknown, idx: number): string => {
  const s = String(raw ?? '').trim();
  return s.length ? s : `column_${idx + 1}`;
};

const cellToString = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (typeof o.text === 'string') return o.text;
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join('');
    if (o.result !== undefined) return cellToString(o.result);
    return JSON.stringify(v);
  }
  return String(v);
};

const parseXlsx = async (buffer: Buffer): Promise<ParsedSpreadsheet> => {
  const wb = new ExcelJS.Workbook();
  // ExcelJS types declare an older Buffer shape than @types/node; the runtime accepts any.
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) throw badRequest('Workbook contains no worksheets');

  const headerRow = sheet.getRow(1);
  if (!headerRow || !headerRow.cellCount) throw badRequest('Header row is empty');

  const columns: string[] = [];
  // ExcelJS uses 1-indexed columns; iterate up to actualColumnCount or cellCount
  const maxCol = sheet.actualColumnCount || sheet.columnCount;
  for (let c = 1; c <= maxCol; c++) {
    columns.push(normalizeHeader(headerRow.getCell(c).value, c - 1));
  }
  if (!columns.length) throw badRequest('No columns detected in header row');

  // Detect duplicate headers — they would silently overwrite each other when mapping rows to objects.
  const seen = new Set<string>();
  for (const col of columns) {
    if (seen.has(col)) throw badRequest(`Duplicate column header: "${col}"`);
    seen.add(col);
  }

  const sampleRows: Record<string, string>[] = [];
  let rowCount = 0;
  // eachRow with includeEmpty: false; r=1 is header
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    rowCount++;
    if (sampleRows.length < SAMPLE_SIZE) {
      const obj: Record<string, string> = {};
      for (let c = 1; c <= columns.length; c++) {
        obj[columns[c - 1]!] = cellToString(row.getCell(c).value);
      }
      sampleRows.push(obj);
    }
  });

  return { columns, rowCount, sampleRows };
};

const parseCsv = async (buffer: Buffer): Promise<ParsedSpreadsheet> => {
  const wb = new ExcelJS.Workbook();
  // ExcelJS csv reader expects a stream; supply a Readable wrapping the buffer
  await wb.csv.read(Readable.from(buffer));
  const sheet = wb.worksheets[0];
  if (!sheet) throw badRequest('CSV produced no worksheet');

  const headerRow = sheet.getRow(1);
  const columns: string[] = [];
  const maxCol = sheet.actualColumnCount || sheet.columnCount;
  for (let c = 1; c <= maxCol; c++) {
    columns.push(normalizeHeader(headerRow.getCell(c).value, c - 1));
  }
  if (!columns.length) throw badRequest('No columns detected in CSV header');

  const seen = new Set<string>();
  for (const col of columns) {
    if (seen.has(col)) throw badRequest(`Duplicate column header: "${col}"`);
    seen.add(col);
  }

  const sampleRows: Record<string, string>[] = [];
  let rowCount = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    rowCount++;
    if (sampleRows.length < SAMPLE_SIZE) {
      const obj: Record<string, string> = {};
      for (let c = 1; c <= columns.length; c++) {
        obj[columns[c - 1]!] = cellToString(row.getCell(c).value);
      }
      sampleRows.push(obj);
    }
  });

  return { columns, rowCount, sampleRows };
};

export const parseSpreadsheet = async (
  buffer: Buffer,
  filename: string,
  contentType: string
): Promise<ParsedSpreadsheet> => {
  const fmt = sniffFormat(filename, contentType);
  if (fmt === 'csv') return parseCsv(buffer);
  return parseXlsx(buffer);
};

/**
 * Stream rows from an already-loaded workbook/csv buffer, yielding plain objects keyed
 * by column header. Used at batch-start materialization to insert recipients without
 * holding all rows in memory at once. (Slice 3 will batch-insert in chunks.)
 */
export async function* iterateRows(
  buffer: Buffer,
  filename: string,
  contentType: string,
  columns: string[]
): AsyncGenerator<Record<string, string>> {
  const fmt = sniffFormat(filename, contentType);
  const wb = new ExcelJS.Workbook();
  if (fmt === 'csv') await wb.csv.read(Readable.from(buffer));
  else await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) throw badRequest('Worksheet missing on re-read');

  // Use a plain for-loop rather than eachRow callback to yield from inside the generator
  const last = sheet.actualRowCount || sheet.rowCount;
  for (let r = 2; r <= last; r++) {
    const row = sheet.getRow(r);
    if (!row || !row.hasValues) continue;
    const obj: Record<string, string> = {};
    let anyValue = false;
    for (let c = 1; c <= columns.length; c++) {
      const v = cellToString(row.getCell(c).value);
      if (v.length) anyValue = true;
      obj[columns[c - 1]!] = v;
    }
    if (anyValue) yield obj;
  }
}
