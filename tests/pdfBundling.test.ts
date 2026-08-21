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
 *  3. @napi-rs/canvas 同样追踪不到（pdf.mjs 走 createRequire() 动态 require，二进制还在平台专属
 *     包里）。它不是「渲染才用」的可选件：pdf.mjs 顶层就有 `const SCALE_MATRIX = new DOMMatrix()`，
 *     polyfill 补不上就在**模块求值阶段**抛 ReferenceError，而 `await import('pdf-parse')` 在路由的
 *     getInfo try 之外 → 又是一个不可读的 500。生产实测链：
 *     "Cannot load @napi-rs/canvas" → "Cannot polyfill DOMMatrix" → "DOMMatrix is not defined"。
 * 第 2、3 条的 include 路径是写死的（前缀 ** 的 glob 会把 build 打成 V8 OOM），一旦 npm 的
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

  it('声明的 pdfjs 资源目录在磁盘上真实存在（防 hoisting 变化后静默失效）', () => {
    // 只管 pdfjs 那批：它们是写死的确定路径，缺一条就是静默失效。
    // @napi-rs 那批不在这里断言——平台专属包按设计只命中一个，顶层那份还可能被 npm hoist 掉；
    // 它们由下面「解析得到的 canvas 必须被 include 覆盖」按 pdfjs 自己的解析口径守，无缺口。
    const includes: string[] = nextConfig.outputFileTracingIncludes[PDF_ROUTES[0]];
    const missing = includes
      .filter((glob) => !glob.includes('@napi-rs'))
      .map((glob) => glob.replace(/\/\*\*$/, '').replace(/^\.\//, ''))
      .filter((dir) => !fs.existsSync(path.join(ROOT, dir)));
    expect(missing).toEqual([]);
  });

  it('pdf-parse 用的那份 pdfjs 能解析到 @napi-rs/canvas，且被 tracing include 覆盖', () => {
    const pdfjsEntry = path.join(
      ROOT,
      'node_modules/pdf-parse/node_modules/pdfjs-dist/legacy/build/pdf.mjs'
    );
    // 按 pdfjs 自己的解析口径找包（createRequire(pdf.mjs) → require('@napi-rs/canvas')）
    const canvasEntry = createRequire(pdfjsEntry).resolve('@napi-rs/canvas');
    // worktree 里 node_modules 是软链到主仓库的，realpath 后再相对化，才能和
    // include 里 "./node_modules/…" 的写法对齐（否则算出 ../../../ 跑到仓库外）
    const nodeModules = fs.realpathSync(path.join(ROOT, 'node_modules'));
    const canvasDir = path.posix.join(
      'node_modules',
      path.relative(nodeModules, path.dirname(canvasEntry))
    );
    expect(canvasDir.startsWith('..'), `canvas 落在 node_modules 外: ${canvasDir}`).toBe(false);

    // 平台二进制是另一个包（canvas-linux-x64-gnu / canvas-darwin-arm64 …），单独确认存在
    const binding = fs
      .readdirSync(path.dirname(path.dirname(canvasEntry)))
      .filter((name) => name.startsWith('canvas-'));
    expect(binding.length, '没装任何 @napi-rs/canvas-<平台> 二进制包').toBeGreaterThan(0);

    const patterns: RegExp[] = nextConfig.outputFileTracingIncludes[PDF_ROUTES[0]].map(globToRegExp);
    const covered = (rel: string) => patterns.some((re) => re.test(rel));
    expect(covered(`${canvasDir}/index.js`), `include 没盖住 ${canvasDir}`).toBe(true);
    for (const name of binding) {
      const rel = `${path.dirname(canvasDir)}/${name}`;
      expect(covered(`${rel}/package.json`), `include 没盖住 ${rel}`).toBe(true);
    }
  });

  it('import pdf-parse 之后 DOMMatrix 必须被补上（补不上则模块求值即崩）', async () => {
    await import('pdf-parse');
    // pdf.mjs 顶层的 `new DOMMatrix()` 依赖这个全局；缺了不是「渲染略糊」而是整条链路 500
    expect(typeof globalThis.DOMMatrix, 'DOMMatrix 未被 polyfill').toBe('function');
    expect(() => new (globalThis.DOMMatrix as new () => unknown)()).not.toThrow();
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

/**
 * 把 outputFileTracingIncludes 的 glob 转成正则，用来判断某个相对路径是否被声明覆盖。
 * `**` 跨层匹配，`*` 只在单层内匹配——与 nft 的口径一致。
 */
function globToRegExp(glob: string): RegExp {
  const source = glob
    .replace(/^\.\//, '')
    .split('/')
    .map((segment) =>
      segment === '**'
        ? '.*'
        : segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
    )
    .join('/');
  return new RegExp(`^${source}$`);
}

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
