import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import {
  assertZipNotBomb,
  extractTextFromFile,
  loadZipGuarded,
  MAX_PPTX_TEXT_CHARS,
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

/**
 * storage-parser#71：`/<a:t>(.*?)<\/a:t>/g` 对**未闭合**的 <a:t> 呈二次复杂度 —— exec 对每个
 * 能匹配 '<a:t>' 的起点都要向后扫描整个后缀去找 '</a:t>'，全部失败才返回 null；`.` 默认不匹配
 * 换行，所以只要载荷里没有换行，每次扫描都跑满整串。
 *
 * 实测曲线（本机 Node 25，'<a:t>' 重复填充）：100KB→480ms、200KB→1.9s、400KB→7.7s、
 * 800KB→31.6s —— 长度翻倍耗时翻四倍，确认 O(L²)。而 loadZipGuarded 允许 200MiB 的声明未压缩量、
 * 这种高度重复的内容压缩比极高，几百 KB 的上传就能解出数十 MB 的 slide XML（小时级 CPU）。
 * 入口 /api/llm/extract-keywords 只要登录即可访问，限流 20 次/分钟 —— 可迅速叠加多个卡死请求。
 */
describe('fileParser PPTX 未闭合标签的复杂度 (storage-parser#71)', () => {
  /** 只有开标签、没有闭标签、且不含换行 —— 触发回溯扫后缀的最坏形态。 */
  async function buildUnclosedPptx(byteLen: number): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<a:t>'.repeat(Math.floor(byteLen / 5)));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  it('400KB 全是未闭合 <a:t> → 线性完成，不再把 CPU 钉死', async () => {
    const buf = await buildUnclosedPptx(400 * 1024);
    const file = new File([new Uint8Array(buf)], 'evil.pptx', { type: MIME_PPTX });

    const startedAt = Date.now();
    const text = await extractTextFromFile(file);
    const elapsedMs = Date.now() - startedAt;

    expect(text).toBe('');
    // 旧正则同样输入要 ~7.7s；`[^<]*` 后是亚毫秒级。阈值留足 NAS/CI 抖动余量。
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('闭合良好的多段文本照常提取（换成 [^<]* 没有改变语义）', async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      '<p:sld><a:t>first</a:t><a:p/><a:t>second</a:t>' +
        // OOXML 里文本内容的 '<' 必须转义成 '&lt;'，字符类不会漏掉它
        '<a:t>a &lt; b</a:t></p:sld>'
    );
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const file = new File([new Uint8Array(buf)], 'ok.pptx', { type: MIME_PPTX });

    expect(await extractTextFromFile(file)).toBe('first\nsecond\na &lt; b');
  });

  it('累计文本超过上限即截断（提取侧的资源闸）', () => {
    expect(MAX_PPTX_TEXT_CHARS).toBe(4_000_000);
  });
});
