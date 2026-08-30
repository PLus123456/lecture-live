import JSZip from 'jszip';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  inspectDocumentArchive,
  verifyDocumentArchiveInflation,
  ZIP_LIMITS,
} from '../../../scripts/document-archive-preflight.mjs';

async function makeZip(
  entries: ReadonlyArray<readonly [string, string]>
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, value] of entries) zip.file(name, value);
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}

function findEocd(buffer: Buffer): number {
  return buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
}

function findCentralEntry(buffer: Buffer): number {
  return buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
}

describe('document ZIP central-directory preflight', () => {
  it('accepts a small bounded OOXML-shaped archive without inflating it', async () => {
    const buffer = await makeZip([
      ['[Content_Types].xml', '<Types/>'],
      ['word/document.xml', '<w:document/>'],
    ]);
    const report = inspectDocumentArchive(buffer, {
      requiredEntries: ['[Content_Types].xml', 'word/document.xml'],
    });
    // JSZip also emits the implicit `word/` directory; directories count too.
    expect(report.entryCount).toBe(3);
    expect(report.totalUncompressedBytes).toBeGreaterThan(0);
  });

  it('rejects entry-count explosions before JSZip sees the archive', async () => {
    const buffer = await makeZip([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ]);
    expect(() =>
      inspectDocumentArchive(buffer, { limits: { maxEntries: 2 } })
    ).toThrow(/entry count exceeds limit/iu);
  });

  it('rejects traversal and backslash paths', async () => {
    await expect(makeZip([['../evil.xml', 'x']])).resolves.toBeInstanceOf(Buffer);
    const traversal = await makeZip([['../evil.xml', 'x']]);
    expect(() => inspectDocumentArchive(traversal)).toThrow(/unsafe segment/iu);

    const backslash = await makeZip([['word\\evil.xml', 'x']]);
    expect(() => inspectDocumentArchive(backslash)).toThrow(/forward slashes/iu);
  });

  it('rejects high per-entry and aggregate compression ratios', async () => {
    const buffer = await makeZip([['word/document.xml', 'a'.repeat(128 * 1024)]]);
    expect(() =>
      inspectDocumentArchive(buffer, {
        limits: { maxCompressionRatio: 2, compressionRatioGraceBytes: 0 },
      })
    ).toThrow(/compression ratio limit/iu);
  });

  it('rejects declared expanded totals before decompression', async () => {
    const buffer = await makeZip([
      ['a.xml', 'a'.repeat(4096)],
      ['b.xml', 'b'.repeat(4096)],
    ]);
    expect(() =>
      inspectDocumentArchive(buffer, { limits: { maxUncompressedBytes: 1024 } })
    ).toThrow(/decompressed size exceeds limit/iu);
  });

  it('rejects bytes hidden after the first complete DEFLATE stream', async () => {
    const value = Buffer.from('bounded document text');
    const compressed = deflateRawSync(value);
    const payload = Buffer.concat([compressed, Buffer.from('hidden')]);

    await expect(
      verifyDocumentArchiveInflation(payload, {
        entryCount: 1,
        centralDirectoryBytes: 0,
        totalCompressedBytes: payload.length,
        totalUncompressedBytes: value.length,
        entries: [
          {
            name: 'word/document.xml',
            compressionMethod: 8,
            crc32: crc32(value) >>> 0,
            compressedSize: payload.length,
            uncompressedSize: value.length,
            dataOffset: 0,
            dataEnd: payload.length,
          },
        ],
      })
    ).rejects.toThrow(/trailing compressed data/iu);
  });

  it('bounds central-directory bytes independently of compressed payload size', async () => {
    const buffer = await makeZip([['a-very-long-entry-name.xml', 'x']]);
    expect(() =>
      inspectDocumentArchive(buffer, { limits: { maxCentralDirectoryBytes: 16 } })
    ).toThrow(/central directory exceeds/iu);
  });

  it('rejects encrypted and ZIP64 metadata rather than guessing sizes', async () => {
    const encrypted = Buffer.from(await makeZip([['safe.xml', 'x']]));
    const central = findCentralEntry(encrypted);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
    expect(() => inspectDocumentArchive(encrypted)).toThrow(/encrypted/iu);

    const zip64 = Buffer.from(await makeZip([['safe.xml', 'x']]));
    const eocd = findEocd(zip64);
    zip64.writeUInt16LE(0xffff, eocd + 10);
    expect(() => inspectDocumentArchive(zip64)).toThrow(/ZIP64/iu);
  });

  it('rejects inconsistent local/central boundaries and missing OOXML parts', async () => {
    const invalidOffset = Buffer.from(await makeZip([['safe.xml', 'x']]));
    const central = findCentralEntry(invalidOffset);
    invalidOffset.writeUInt32LE(invalidOffset.length, central + 42);
    expect(() => inspectDocumentArchive(invalidOffset)).toThrow(/local header/iu);

    const conflictingMetadata = Buffer.from(await makeZip([['safe.xml', 'x']]));
    const local = conflictingMetadata.indexOf(
      Buffer.from([0x50, 0x4b, 0x03, 0x04])
    );
    const localMethod = conflictingMetadata.readUInt16LE(local + 8);
    conflictingMetadata.writeUInt16LE(localMethod === 0 ? 8 : 0, local + 8);
    expect(() => inspectDocumentArchive(conflictingMetadata)).toThrow(
      /local and central compression metadata disagree/iu
    );

    const missing = await makeZip([['word/document.xml', '<w:document/>']]);
    expect(() =>
      inspectDocumentArchive(missing, {
        requiredEntries: ['[Content_Types].xml', 'word/document.xml'],
      })
    ).toThrow(/missing required part/iu);
  });

  it('keeps production limits explicit and finite', () => {
    expect(ZIP_LIMITS).toMatchObject({
      maxEntries: 10_000,
      maxCentralDirectoryBytes: 16 * 1024 * 1024,
      maxUncompressedBytes: 200 * 1024 * 1024,
      maxCompressionRatio: 100,
    });
  });
});
