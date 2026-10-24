import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DOCUMENT_PARSER_MAX_QUEUED_BYTES,
  DOCUMENT_PARSER_MAX_OLD_SPACE_MB,
  extractAttachmentDocumentText,
  extractKeywordDocumentText,
  inspectPdfDocument,
  runRestrictedDocumentParser,
} from '@/lib/documentParserProcess';

const MIME_PPTX =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** 最小可解析 PPTX：一页一个文本框。 */
async function buildMinimalPptx(slideText: string): Promise<Buffer> {
  const nsP = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const nsA = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const nsR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
      '</Types>'
  );
  zip.file(
    '_rels/.rels',
    `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '</Relationships>'
  );
  zip.file(
    'ppt/presentation.xml',
    `${xml}<p:presentation xmlns:p="${nsP}" xmlns:r="${nsR}" xmlns:a="${nsA}">` +
      '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>'
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
      '</Relationships>'
  );
  zip.file(
    'ppt/slides/slide1.xml',
    `${xml}<p:sld xmlns:p="${nsP}" xmlns:a="${nsA}" xmlns:r="${nsR}"><p:cSld><p:spTree><p:sp>` +
      `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${slideText}</a:t></a:r></a:p></p:txBody>` +
      '</p:sp></p:spTree></p:cSld></p:sld>'
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const PROBE_WORKER = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'document-parser-probe.mjs'
);

function findCentralRecord(buffer: Buffer, target: string): number {
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let cursor = 0;
  while ((cursor = buffer.indexOf(signature, cursor)) >= 0) {
    const nameBytes = buffer.readUInt16LE(cursor + 28);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameBytes).toString('utf8');
    if (name === target) return cursor;
    cursor += 46 + nameBytes;
  }
  throw new Error(`Missing central entry: ${target}`);
}

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.JWT_SECRET;
});

describe('restricted document parser process', () => {
  it('reads PDF page metadata through the child-process boundary', async () => {
    const stream = 'BT /F1 18 Tf 20 100 Td (LectureLive) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R ' +
        '/Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    const chunks = [Buffer.from('%PDF-1.4\n')];
    const offsets: number[] = [];
    let cursor = chunks[0].length;
    objects.forEach((object, index) => {
      offsets.push(cursor);
      const body = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`);
      chunks.push(body);
      cursor += body.length;
    });
    const xref =
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
      offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    chunks.push(
      Buffer.from(
        `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
          `startxref\n${cursor}\n%%EOF\n`
      )
    );

    await expect(inspectPdfDocument(Buffer.concat(chunks))).resolves.toEqual({
      pages: 1,
    });
  });

  // officeparser v8 删除了 ast.toText()：旧 worker 写法在 v8 下不报错、只返回空串，
  // 聊天附件里的 PPTX 会静默变成空白。这里走真实受限子进程 + 真实 officeparser 守住。
  it('extracts PPTX attachment text through the Office parser', async () => {
    const buffer = await buildMinimalPptx('LectureLive slide text');
    const result = await extractAttachmentDocumentText(buffer, MIME_PPTX);
    expect(result.text).toContain('LectureLive slide text');
    expect(result.truncated).toBe(false);
  });

  it('has an explicit V8 heap ceiling, high enough for ordinary documents', () => {
    // 上限存在是必需的（爆炸半径限制在可终止的子进程里），但不能低到打死正常文件：
    // 实测 10 万段落的 276KB .docx 和 20 万行的 6.3MB .xlsx 在 256MB 下直接 SIGABRT，
    // 而它们在改成子进程解析之前只会被截断、不会失败。
    expect(DOCUMENT_PARSER_MAX_OLD_SPACE_MB).toBe(1024);
    expect(DOCUMENT_PARSER_MAX_OLD_SPACE_MB).toBeGreaterThanOrEqual(512);
  });

  it('rejects a high-ratio OOXML archive before spawning the parser', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('ppt/presentation.xml', '<p:presentation/>');
    zip.file('ppt/slides/slide1.xml', 'a'.repeat(2 * 1024 * 1024));
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
    await expect(
      extractKeywordDocumentText(
        buffer,
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      )
    ).rejects.toMatchObject({ code: 'archive_limit' });
  });

  it('measures actual inflate bytes when local and central sizes are both forged', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('ppt/presentation.xml', '<p:presentation/>');
    zip.file('ppt/slides/slide1.xml', 'z'.repeat(4 * 1024 * 1024));
    const forged = Buffer.from(
      await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      })
    );
    const central = findCentralRecord(forged, 'ppt/slides/slide1.xml');
    const local = forged.readUInt32LE(central + 42);
    forged.writeUInt32LE(1, central + 24);
    forged.writeUInt32LE(1, local + 22);

    await expect(
      extractKeywordDocumentText(
        forged,
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      )
    ).rejects.toMatchObject({ code: 'archive_limit' });
  });

  it('verifies actual CRC before handing bytes to the Office parser', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('ppt/presentation.xml', '<p:presentation/>');
    zip.file('ppt/slides/slide1.xml', '<a:t>crc check</a:t>');
    const forged = Buffer.from(
      await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    );
    const central = findCentralRecord(forged, 'ppt/slides/slide1.xml');
    const local = forged.readUInt32LE(central + 42);
    forged.writeUInt32LE(0, central + 16);
    forged.writeUInt32LE(0, local + 14);

    await expect(
      extractKeywordDocumentText(
        forged,
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      )
    ).rejects.toMatchObject({ code: 'invalid_archive' });
  });

  it('kills a child whose event loop is permanently blocked', async () => {
    const startedAt = Date.now();
    await expect(
      runRestrictedDocumentParser(
        'keyword-text',
        Buffer.from('x'),
        'test/hang',
        { workerPath: PROBE_WORKER, timeoutMs: 100 }
      )
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('contains a child V8 heap OOM and releases the parser slot', async () => {
    await expect(
      runRestrictedDocumentParser(
        'keyword-text',
        Buffer.from('x'),
        'test/heap-oom',
        {
          workerPath: PROBE_WORKER,
          maxOldSpaceMb: 16,
          timeoutMs: 10_000,
        }
      )
    ).rejects.toMatchObject({ code: 'worker_failed' });

    await expect(
      runRestrictedDocumentParser(
        'keyword-text',
        Buffer.from('x'),
        'test/ok',
        { workerPath: PROBE_WORKER }
      )
    ).resolves.toMatchObject({ text: 'ok' });
  });

  it('kills and reaps the child when the request is cancelled', async () => {
    const controller = new AbortController();
    const task = runRestrictedDocumentParser(
      'keyword-text',
      Buffer.from('x'),
      'test/hang',
      { workerPath: PROBE_WORKER, signal: controller.signal, timeoutMs: 5_000 }
    );
    setTimeout(() => controller.abort(), 100);
    await expect(task).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('denies sockets in the child runtime', async () => {
    const value = (await runRestrictedDocumentParser(
      'keyword-text',
      Buffer.from('x'),
      'test/network',
      { workerPath: PROBE_WORKER }
    )) as { text: string };
    expect(value.text).toMatch(
      /ERR_(?:ACCESS_DENIED|DOCUMENT_PARSER_NETWORK_DENIED)/u
    );
  });

  it('denies unrelated reads, writes and subprocesses and strips secrets', async () => {
    process.env.DATABASE_URL = 'mysql://secret';
    process.env.JWT_SECRET = 'do-not-inherit';
    const value = (await runRestrictedDocumentParser(
      'keyword-text',
      Buffer.from('x'),
      'test/permissions',
      { workerPath: PROBE_WORKER }
    )) as { text: string };
    const result = JSON.parse(value.text) as Record<string, string>;

    expect(result).toEqual({
      read: 'ERR_ACCESS_DENIED',
      write: 'ERR_ACCESS_DENIED',
      spawn: 'ERR_ACCESS_DENIED',
      databaseSecret: 'absent',
      jwtSecret: 'absent',
    });
  });

  it('bounds queued parser bytes while two children are active', async () => {
    const payload = Buffer.alloc(9 * 1024 * 1024, 0x61);
    const controllers: AbortController[] = [];
    const tasks: Array<Promise<unknown>> = [];
    const start = (): void => {
      const controller = new AbortController();
      controllers.push(controller);
      tasks.push(
        runRestrictedDocumentParser(
          'keyword-text',
          payload,
          'test/hang',
          {
            workerPath: PROBE_WORKER,
            signal: controller.signal,
            timeoutMs: 5_000,
          }
        ).catch((error) => error)
      );
    };

    start();
    start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const queueItems = Math.floor(DOCUMENT_PARSER_MAX_QUEUED_BYTES / payload.length);
    for (let index = 0; index < queueItems; index += 1) start();

    await expect(
      runRestrictedDocumentParser(
        'keyword-text',
        payload,
        'test/hang',
        { workerPath: PROBE_WORKER, timeoutMs: 5_000 }
      )
    ).rejects.toMatchObject({ code: 'busy' });

    controllers.forEach((controller) => controller.abort());
    await Promise.all(tasks);
  });
});
