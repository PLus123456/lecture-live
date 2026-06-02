import { promises as fs } from 'fs';
import path from 'path';

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import {
  MAX_OUTPUT_CHARS,
  TRUNCATION_MARKER,
  UnsupportedMimeError,
  extractTextFromBuffer,
  isExtractableMime,
} from '@/lib/llm/fileExtractor';

const FIXTURE_DIR = path.resolve(__dirname, '../../../../tests/fixtures');

const MIME_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function readFixture(name: string): Promise<Buffer> {
  return fs.readFile(path.join(FIXTURE_DIR, name));
}

/** Build a real .xlsx workbook in-memory (exceljs) for round-trip parse tests. */
async function buildXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet('Sheet1');
  s1.addRow(['Name', 'Age']);
  s1.addRow(['Alice', 30]);
  const s2 = wb.addWorksheet('Data');
  s2.addRow(['x', 'y']);
  // formula + richText to confirm cell.text flattening is used
  s2.getCell('A2').value = { formula: '1+1', result: 2 };
  s2.getCell('B2').value = { richText: [{ text: 'rich ' }, { text: 'text' }] };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Minimal, valid single-page PDF whose page content stream prints "Hello PDF". */
function buildMinimalPdf(): Buffer {
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT /F1 24 Tf 100 700 Td (Hello PDF) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000241 00000 n
0000000330 00000 n
trailer
<< /Size 6 /Root 1 0 R >>
startxref
399
%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

describe('fileExtractor', () => {
  describe('extractTextFromBuffer', () => {
    it('decodes text/plain as UTF-8', async () => {
      const buf = await readFixture('sample.txt');
      const result = await extractTextFromBuffer(buf, 'text/plain');

      expect(result.text).toContain('hello world');
      expect(result.text).toContain('二段中文');
      expect(result.text).toBe(buf.toString('utf8'));
      expect(result.truncated).toBe(false);
      expect(result.pages).toBeUndefined();
    });

    it('decodes application/json as UTF-8', async () => {
      const buf = await readFixture('sample.json');
      const result = await extractTextFromBuffer(buf, 'application/json');

      expect(result.text).toContain('"a":1');
      expect(result.truncated).toBe(false);
    });

    it('honors the MIME prefix match for text/* (e.g. text/markdown)', async () => {
      const buf = Buffer.from('# hello\n世界', 'utf8');
      const result = await extractTextFromBuffer(buf, 'text/markdown');

      expect(result.text).toBe('# hello\n世界');
      expect(result.truncated).toBe(false);
    });

    it('is case-insensitive on MIME type', async () => {
      const buf = Buffer.from('ok', 'utf8');
      const result = await extractTextFromBuffer(buf, 'TEXT/Plain');

      expect(result.text).toBe('ok');
      expect(result.truncated).toBe(false);
    });

    it('truncates very large text inputs to MAX_OUTPUT_CHARS + marker', async () => {
      // 3 MB of ASCII 'a' — comfortably exceeds 2 000 000 chars.
      const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
      const result = await extractTextFromBuffer(big, 'text/plain');

      expect(result.truncated).toBe(true);
      expect(result.text.length).toBe(
        MAX_OUTPUT_CHARS + TRUNCATION_MARKER.length
      );
      expect(result.text.endsWith(TRUNCATION_MARKER)).toBe(true);
    });

    it('does not truncate when input is exactly at the cap', async () => {
      // Buffer.alloc with fill byte avoids materializing a 2 MB intermediate string.
      const justAtCap = Buffer.alloc(MAX_OUTPUT_CHARS, 0x78);
      const result = await extractTextFromBuffer(justAtCap, 'text/plain');

      expect(result.truncated).toBe(false);
      expect(result.text.length).toBe(MAX_OUTPUT_CHARS);
    });

    it('throws UnsupportedMimeError for unrecognized MIME', async () => {
      const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // ZIP magic
      await expect(
        extractTextFromBuffer(buf, 'application/zip')
      ).rejects.toBeInstanceOf(UnsupportedMimeError);
    });

    it('UnsupportedMimeError exposes the offending MIME', async () => {
      try {
        await extractTextFromBuffer(Buffer.alloc(0), 'application/x-foo');
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedMimeError);
        expect((error as UnsupportedMimeError).mimeType).toBe(
          'application/x-foo'
        );
      }
    });
  });

  describe('document parsing (xlsx / pdf)', () => {
    it('extracts cell text from a real .xlsx via exceljs', async () => {
      const buf = await buildXlsx();
      const result = await extractTextFromBuffer(buf, MIME_XLSX);

      // sheet headers + values across both worksheets
      expect(result.text).toContain('# Sheet1');
      expect(result.text).toContain('Name,Age');
      expect(result.text).toContain('Alice,30');
      expect(result.text).toContain('# Data');
      // cell.text flattens formula result and rich text
      expect(result.text).toContain('2');
      expect(result.text).toContain('rich text');
      expect(result.truncated).toBe(false);
      // xlsx path does not report pages
      expect(result.pages).toBeUndefined();
    });

    it('extracts text and page count from a real PDF via pdf-parse v2', async () => {
      const buf = buildMinimalPdf();
      const result = await extractTextFromBuffer(buf, 'application/pdf');

      expect(result.text).toContain('Hello PDF');
      // pageJoiner:'' must suppress the "-- N of M --" page markers
      expect(result.text).not.toMatch(/-- \d+ of \d+ --/);
      expect(result.pages).toBe(1);
      expect(result.truncated).toBe(false);
    });
  });

  describe('isExtractableMime', () => {
    it('returns true for supported document MIMEs', () => {
      expect(isExtractableMime('application/pdf')).toBe(true);
      expect(
        isExtractableMime(
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        )
      ).toBe(true);
      expect(
        isExtractableMime(
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
      ).toBe(true);
      expect(isExtractableMime('application/vnd.ms-excel')).toBe(true);
      expect(
        isExtractableMime(
          'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        )
      ).toBe(true);
    });

    it('returns true for text/* and application JSON/YAML/etc.', () => {
      expect(isExtractableMime('text/plain')).toBe(true);
      expect(isExtractableMime('text/markdown')).toBe(true);
      expect(isExtractableMime('text/csv')).toBe(true);
      expect(isExtractableMime('application/json')).toBe(true);
      expect(isExtractableMime('application/yaml')).toBe(true);
      expect(isExtractableMime('application/x-sh')).toBe(true);
    });

    it('returns false for unsupported MIME (e.g. zip / image)', () => {
      expect(isExtractableMime('application/zip')).toBe(false);
      expect(isExtractableMime('image/png')).toBe(false);
      expect(isExtractableMime('audio/mp3')).toBe(false);
    });

    it('is case-insensitive', () => {
      expect(isExtractableMime('APPLICATION/PDF')).toBe(true);
      expect(isExtractableMime('Text/Plain')).toBe(true);
    });
  });
});
