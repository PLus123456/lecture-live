import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  copyFileRange,
  MAX_AUTHORITATIVE_WEBM_DOCUMENTS,
  scanWebmDocumentRanges,
  WebmDocumentScanError,
} from '@/lib/audio/webmDocuments';

const tempDirs: string[] = [];
const EBML_WEBM = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
]);
const EBML_MATROSKA = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88, 0x6d, 0x61, 0x74, 0x72, 0x6f,
  0x73, 0x6b, 0x61,
]);

async function tempFile(name: string, bytes: Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'll-webm-scan-test-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, bytes);
  return filePath;
}

function syntheticDocument(size: number, fill = 0x11): Buffer {
  if (size < EBML_WEBM.length) throw new Error('synthetic document too small');
  return Buffer.concat([
    EBML_WEBM,
    Buffer.alloc(size - EBML_WEBM.length, fill),
  ]);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      fs.rm(dir, { recursive: true, force: true })
    )
  );
});

describe('strict authoritative WebM document scanner', () => {
  it('finds byte-concatenated documents and returns exact half-open ranges', async () => {
    const first = syntheticDocument(4096);
    const second = syntheticDocument(8192, 0x22);
    const filePath = await tempFile('concat.webm', Buffer.concat([first, second]));

    await expect(scanWebmDocumentRanges(filePath)).resolves.toEqual([
      { start: 0, end: first.length },
      { start: first.length, end: first.length + second.length },
    ]);
  });

  it('detects an EBML header split across scanner chunks', async () => {
    const secondOffset = 1024 * 1024 - 2;
    const first = syntheticDocument(secondOffset);
    const second = syntheticDocument(4096, 0x33);
    const filePath = await tempFile('boundary.webm', Buffer.concat([first, second]));

    await expect(scanWebmDocumentRanges(filePath)).resolves.toEqual([
      { start: 0, end: secondOffset },
      { start: secondOffset, end: secondOffset + second.length },
    ]);
  });

  it('accepts the Matroska DocType as an EBML document boundary', async () => {
    const filePath = await tempFile(
      'single.mkv',
      Buffer.concat([EBML_MATROSKA, Buffer.alloc(4096, 0x44)])
    );

    await expect(scanWebmDocumentRanges(filePath)).resolves.toEqual([
      { start: 0, end: EBML_MATROSKA.length + 4096 },
    ]);
  });

  it('fails closed instead of spawning unbounded probes for many documents', async () => {
    const bytes = Buffer.concat(
      Array.from(
        { length: MAX_AUTHORITATIVE_WEBM_DOCUMENTS + 1 },
        () => syntheticDocument(64)
      )
    );
    const filePath = await tempFile('too-many.webm', bytes);

    await expect(scanWebmDocumentRanges(filePath)).rejects.toBeInstanceOf(
      WebmDocumentScanError
    );
  });

  it('copies only the requested document range with bounded I/O', async () => {
    const source = await tempFile(
      'source.webm',
      Buffer.concat([Buffer.from('prefix'), Buffer.from('wanted'), Buffer.from('suffix')])
    );
    const destination = path.join(path.dirname(source), 'range.webm');

    await copyFileRange(source, { start: 6, end: 12 }, destination);

    await expect(fs.readFile(destination, 'utf8')).resolves.toBe('wanted');
  });
});
