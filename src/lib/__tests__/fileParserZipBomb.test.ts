import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  assertZipInflationWithinLimit,
  assertZipNotBomb,
  loadZipGuarded,
  MAX_ZIP_ENTRIES,
} from '@/lib/fileParser';

/**
 * M27：`assertZipNotBomb` 累加的是 ZIP 中央目录里**声明**的 uncompressedSize。
 * JSZip 在 loadAsync 阶段既不解压也不校验声明值与实际流一致
 * （`compressedObject.js:37` 那句 `data_length !== uncompressedSize` 是 inflate
 * **之后**才跑的，那时内存尖峰已经发生），所以声明值可以随便撒谎。
 *
 * 这里手工拼一个「声明 1KB、实际解出 2MB」的 ZIP 来坐实绕过，
 * 并验证新加的 `assertZipInflationWithinLimit`（按**实际**输出字节计数）能拦住它。
 */

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value, 0);
  return b;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

/**
 * 手工构造单条目 ZIP。`declaredUncompressedSize` 与实际解压结果**可以不一致** ——
 * 这正是要复现的攻击。
 */
function buildZip(
  fileName: string,
  payload: Buffer,
  declaredUncompressedSize: number
): Buffer {
  const nameBuf = Buffer.from(fileName, 'utf-8');
  const compressed = deflateRawSync(payload, { level: 9 });
  const crc = 0; // JSZip 的 loadAsync 默认 checkCRC32:false，这里不需要真值

  const localHeader = Buffer.concat([
    u32(0x04034b50),
    u16(20), // version needed
    u16(0), // flags
    u16(8), // method = deflate
    u16(0), // time
    u16(0), // date
    u32(crc),
    u32(compressed.length),
    u32(declaredUncompressedSize), // ← 谎报
    u16(nameBuf.length),
    u16(0),
    nameBuf,
  ]);

  const centralHeader = Buffer.concat([
    u32(0x02014b50),
    u16(20), // version made by
    u16(20), // version needed
    u16(0), // flags
    u16(8), // method
    u16(0),
    u16(0),
    u32(crc),
    u32(compressed.length),
    u32(declaredUncompressedSize), // ← 谎报
    u16(nameBuf.length),
    u16(0), // extra len
    u16(0), // comment len
    u16(0), // disk number
    u16(0), // internal attrs
    u32(0), // external attrs
    u32(0), // local header offset
    nameBuf,
  ]);

  const cdOffset = localHeader.length + compressed.length;
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(centralHeader.length),
    u32(cdOffset),
    u16(0),
  ]);

  return Buffer.concat([localHeader, compressed, centralHeader, eocd]);
}

const ONE_KB = 1024;
const TWO_MB = 2 * 1024 * 1024;

/** 高压缩比载荷：2MB 全零 → deflate 后只有约 2KB。 */
const BOMB_PAYLOAD = Buffer.alloc(TWO_MB, 0);

describe('M27 —— ZIP 声明大小可以撒谎', () => {
  it('旧守卫（按声明值）对「声明 1KB / 实际 2MB」完全无感', async () => {
    const zipBuffer = buildZip('word/document.xml', BOMB_PAYLOAD, ONE_KB);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(zipBuffer);

    // 上限设成 64KB —— 实际内容 2MB 早就越线了，但声明值只有 1KB，守卫毫无反应
    expect(() => assertZipNotBomb(zip, 64 * 1024)).not.toThrow();

    // JSZip 确实有一致性校验，但它在 **inflate 结束之后** 才跑
    // （compressedObject.js:37 `data_length !== uncompressedSize`）——
    // 也就是说 2MB 已经完整解出来、内存尖峰已经发生，才抛出这个错。
    // 把 2MB 换成攻击者实际会用的几十 GB，进程在抛错之前就 OOM 了。
    await expect(
      zip.file('word/document.xml')!.async('uint8array')
    ).rejects.toThrow(/uncompressed data size mismatch/);
  });

  it('新守卫（按实际解压字节）拦得住', async () => {
    const zipBuffer = buildZip('word/document.xml', BOMB_PAYLOAD, ONE_KB);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(zipBuffer);

    await expect(
      assertZipInflationWithinLimit(zip, 64 * 1024)
    ).rejects.toThrow(/Decompressed size exceeds limit/);
  });

  it('loadZipGuarded 端到端拒绝谎报体积的炸弹', async () => {
    const zipBuffer = buildZip('word/document.xml', BOMB_PAYLOAD, ONE_KB);

    await expect(loadZipGuarded(zipBuffer, 64 * 1024)).rejects.toThrow(
      /possible zip bomb/
    );
  });

  it('诚实的小文档照常通过两道守卫', async () => {
    const payload = Buffer.from('<w:document>hello</w:document>', 'utf-8');
    const zipBuffer = buildZip('word/document.xml', payload, payload.length);

    const zip = await loadZipGuarded(zipBuffer, 64 * 1024);
    const text = await zip.file('word/document.xml')!.async('text');
    expect(text).toContain('hello');
  });

  it('诚实地声明超大体积仍走廉价前置过滤（不必白解压一遍）', async () => {
    const payload = Buffer.alloc(4096, 0);
    const zipBuffer = buildZip('word/document.xml', payload, 900 * 1024 * 1024);

    await expect(loadZipGuarded(zipBuffer, 64 * 1024)).rejects.toThrow(
      /Decompressed size exceeds limit/
    );
  });

  it('条目数上限常量已定义（防「几百万个 1 字节条目」）', () => {
    expect(MAX_ZIP_ENTRIES).toBeGreaterThan(0);
  });
});
