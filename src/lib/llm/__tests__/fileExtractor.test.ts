import { promises as fs } from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  MAX_OUTPUT_CHARS,
  TRUNCATION_MARKER,
  UnsupportedMimeError,
  extractTextFromBuffer,
  isExtractableMime,
} from '@/lib/llm/fileExtractor';

const FIXTURE_DIR = path.resolve(__dirname, '../../../../tests/fixtures');

async function readFixture(name: string): Promise<Buffer> {
  return fs.readFile(path.join(FIXTURE_DIR, name));
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
