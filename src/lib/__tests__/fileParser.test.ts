import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import {
  assertZipNotBomb,
  extractTextFromFile,
  loadZipGuarded,
  MAX_UNCOMPRESSED_BYTES,
} from '@/lib/fileParser';

/**
 * Build a ZIP whose entries declare a large uncompressed size but compress to a
 * tiny footprint (a "decompression bomb"). `targetUncompressed` controls the
 * declared inflated size so tests can stay cheap by pairing a small payload with
 * a small `maxBytes` override on the guard.
 */
async function buildZipBomb(targetUncompressed: number): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('xl/worksheets/sheet1.xml', 'a'.repeat(targetUncompressed));
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}

/** Minimal valid PPTX (ZIP) with one slide containing an <a:t> text run. */
async function buildPptx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'ppt/slides/slide1.xml',
    `<?xml version="1.0"?><p:sld xmlns:p="x" xmlns:a="y"><a:t>${text}</a:t></p:sld>`
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const MIME_PPTX =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

describe('fileParser zip-bomb guard', () => {
  it('assertZipNotBomb passes for a normal small archive', async () => {
    const zip = await JSZip.loadAsync(await buildPptx('hello'));
    expect(() => assertZipNotBomb(zip)).not.toThrow();
  });

  it('assertZipNotBomb rejects when summed uncompressed size exceeds the cap', async () => {
    // declared inflated size 8KB, cap 1KB → must throw
    const bomb = await buildZipBomb(8 * 1024);
    const zip = await JSZip.loadAsync(bomb);
    expect(() => assertZipNotBomb(zip, 1024)).toThrow(
      /zip bomb|exceeds limit/i
    );
  });

  it('loadZipGuarded rejects a bomb (compressed tiny, inflated huge)', async () => {
    const bomb = await buildZipBomb(8 * 1024);
    // compressed footprint is tiny — this is the OOM vector being defended
    expect(bomb.length).toBeLessThan(1024);
    await expect(loadZipGuarded(bomb, 1024)).rejects.toThrow(
      /zip bomb|exceeds limit/i
    );
  });

  it('loadZipGuarded resolves to a usable JSZip for a benign archive', async () => {
    const zip = await loadZipGuarded(await buildPptx('world'));
    const xml = await zip.files['ppt/slides/slide1.xml'].async('text');
    expect(xml).toContain('world');
  });

  it('exposes a 200MB default cap', () => {
    expect(MAX_UNCOMPRESSED_BYTES).toBe(200 * 1024 * 1024);
  });
});

describe('fileParser extractTextFromFile', () => {
  it('extracts <a:t> runs from a PPTX', async () => {
    const buf = await buildPptx('Slide content here');
    const file = new File([new Uint8Array(buf)], 'deck.pptx', { type: MIME_PPTX });
    const text = await extractTextFromFile(file);
    expect(text).toContain('Slide content here');
  });

  it('decodes text/plain as UTF-8', async () => {
    const file = new File([Buffer.from('héllo 世界', 'utf8')], 'a.txt', {
      type: 'text/plain',
    });
    expect(await extractTextFromFile(file)).toBe('héllo 世界');
  });

  it('rejects an unsupported MIME type', async () => {
    const file = new File([Buffer.from('x')], 'a.bin', {
      type: 'application/octet-stream',
    });
    await expect(extractTextFromFile(file)).rejects.toThrow(/Unsupported/);
  });
});
