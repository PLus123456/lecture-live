import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * PDF 解析链路的打包契约。
 *
 * 两个真实事故都发生在打包层，业务单测（无 webpack）和 e2e（无库 harness，全部端点被 mock）
 * 结构上都看不见，只能靠这里守：
 *  1. pdf-parse 不在 serverExternalPackages 里 → webpack 打进 server bundle，
 *     `await import('pdf-parse')` 抛 "Object.defineProperty called on non-object"，
 *     /api/translate/documents 直接 500（前端 toast "Internal server error"）。
 *  2. pdfjs 的 worker/CMap 是运行时按路径加载的，nft 追踪不到 → standalone 产物缺文件，
 *     dev 正常但生产抛 "Setting up fake worker failed: Cannot find module …/pdf.worker.mjs"。
 *     install.sh 与 Dockerfile 都只拷 .next/standalone，缺了就是线上炸。
 * 第 2 条的 include 路径是写死的（前缀 ** 的 glob 会把 build 打成 V8 OOM），一旦 npm 的
 * hoisting 结构变化就会静默失效——所以这里连磁盘上是否真有这些文件一起断言。
 */

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nextConfig = require_(path.join(ROOT, 'next.config.js')) as any;

/** 解析 PDF 的三条服务端入口：documents=pdf-parse，chat-uploads/extract-keywords=fileExtractor/fileParser */
const PDF_ROUTES = [
  '/api/translate/documents',
  '/api/chat-uploads',
  '/api/llm/extract-keywords',
];

describe('PDF 解析的打包契约', () => {
  it('pdf-parse 必须是服务端外部包（否则 webpack 打包后 import 即崩）', () => {
    expect(nextConfig.serverExternalPackages).toContain('pdf-parse');
  });

  it('每条解析 PDF 的路由都声明了 pdfjs 运行时资源', () => {
    const includes = nextConfig.outputFileTracingIncludes ?? {};
    for (const route of PDF_ROUTES) {
      expect(Object.keys(includes)).toContain(route);
      expect(includes[route].length).toBeGreaterThan(0);
    }
  });

  it('声明的资源目录在磁盘上真实存在（防 hoisting 变化后静默失效）', () => {
    const includes: string[] = nextConfig.outputFileTracingIncludes[PDF_ROUTES[0]];
    const missing = includes
      .map((glob) => glob.replace(/\/\*\*$/, '').replace(/^\.\//, ''))
      .filter((dir) => !fs.existsSync(path.join(ROOT, dir)));
    expect(missing).toEqual([]);
  });

  it('两份 pdfjs-dist 的 worker 文件都存在（pdf-parse 内嵌 + officeparser 顶层）', () => {
    const workers = [
      'node_modules/pdf-parse/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    ];
    for (const rel of workers) {
      expect(fs.existsSync(path.join(ROOT, rel)), `缺失 ${rel}`).toBe(true);
    }
  });

  it('pdf-parse 在 node 侧可正常读取页数与文本', async () => {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: makeMinimalPdf() });
    try {
      const info = await parser.getInfo();
      expect(info.total).toBe(1);
      const text = await parser.getText({ pageJoiner: '' });
      expect(text.text).toContain('LectureLive');
    } finally {
      await parser.destroy();
    }
  });
});

/** 最小合法单页 PDF（内联生成，避免往仓库塞二进制夹具） */
function makeMinimalPdf(): Buffer {
  const stream = 'BT /F1 18 Tf 20 100 Td (LectureLive) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let cursor = chunks[0].length;
  objects.forEach((obj, i) => {
    offsets.push(cursor);
    const body = Buffer.from(`${i + 1} 0 obj\n${obj}\nendobj\n`);
    chunks.push(body);
    cursor += body.length;
  });

  const size = objects.length + 1;
  const xref =
    `xref\n0 ${size}\n0000000000 65535 f \n` +
    offsets.map((off) => `${String(off).padStart(10, '0')} 00000 n \n`).join('');
  chunks.push(
    Buffer.from(
      `${xref}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`
    )
  );
  return Buffer.concat(chunks);
}
