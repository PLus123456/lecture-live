import fs from 'node:fs';
import {
  inspectDocumentArchive,
  verifyDocumentArchiveInflation,
} from './document-archive-preflight.mjs';

const MIME_PDF = 'application/pdf';
const MIME_DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_XLS = 'application/vnd.ms-excel';
const MIME_PPTX =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_KEYWORD_TEXT_CHARS = 4_000_000;
const MAX_ATTACHMENT_TEXT_CHARS = 2_000_000;
const TRUNCATION_MARKER = '\n\n…[文档过长，已截断]';

const OOXML_REQUIRED_ENTRIES = Object.freeze({
  [MIME_DOCX]: ['[Content_Types].xml', 'word/document.xml'],
  [MIME_XLSX]: ['[Content_Types].xml', 'xl/workbook.xml'],
  [MIME_PPTX]: ['[Content_Types].xml', 'ppt/presentation.xml'],
});

function safeError(error) {
  const code =
    typeof error?.code === 'string' &&
    ['archive_limit', 'invalid_archive', 'unsupported_type'].includes(error.code)
      ? error.code
      : 'invalid_document';
  const message =
    code === 'archive_limit' || code === 'invalid_archive'
      ? String(error?.message || 'Document archive rejected')
      : code === 'unsupported_type'
        ? 'Unsupported document type'
        : 'Document parsing failed';
  return { code, message };
}

function writeResponse(response) {
  // Descriptor 3 is a parent-created pipe. Node's permission model intentionally
  // permits existing descriptors without granting arbitrary filesystem writes.
  fs.writeFileSync(3, JSON.stringify(response), 'utf8');
}

async function readInput() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_INPUT_BYTES) {
      const error = new Error(`Document exceeds parser input limit (${MAX_INPUT_BYTES} bytes)`);
      error.code = 'archive_limit';
      throw error;
    }
    chunks.push(chunk);
  }
  if (total === 0) throw new Error('Empty document');
  return Buffer.concat(chunks, total);
}

async function preflightOffice(buffer, mimeType) {
  const requiredEntries = OOXML_REQUIRED_ENTRIES[mimeType] ?? [];
  const report = inspectDocumentArchive(buffer, { requiredEntries });
  await verifyDocumentArchiveInflation(buffer, report);
}

function clamp(text, maxChars, marker = '') {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + marker, truncated: true };
}

async function parsePdf(buffer, infoOnly) {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    if (infoOnly) {
      const info = await parser.getInfo();
      return { pages: info.total };
    }
    const result = await parser.getText({ pageJoiner: '' });
    return { text: result.text ?? '', pages: result.total };
  } finally {
    await parser.destroy();
  }
}

async function parseDocx(buffer) {
  await preflightOffice(buffer, MIME_DOCX);
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? '';
}

async function parsePptxForKeywords(buffer) {
  await preflightOffice(buffer, MIME_PPTX);
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const texts = [];
  let totalChars = 0;

  for (const [name, entry] of Object.entries(zip.files)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/u.test(name)) continue;
    const xml = await entry.async('text');
    const pattern = /<a:t>([^<]*)<\/a:t>/gu;
    let match;
    while ((match = pattern.exec(xml)) !== null) {
      if (!match[1]) continue;
      texts.push(match[1]);
      totalChars += match[1].length;
      if (totalChars >= MAX_KEYWORD_TEXT_CHARS) {
        return texts.join('\n').slice(0, MAX_KEYWORD_TEXT_CHARS);
      }
    }
  }
  return texts.join('\n');
}

async function parseXlsx(buffer) {
  await preflightOffice(buffer, MIME_XLSX);
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(buffer).buffer);
  const parts = [];
  workbook.eachSheet((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.text) cells.push(cell.text);
      });
      if (cells.length > 0) rows.push(cells.join(','));
    });
    parts.push(`# ${sheet.name}\n${rows.join('\n')}`);
  });
  return parts.join('\n\n');
}

async function parsePptxForAttachment(buffer) {
  await preflightOffice(buffer, MIME_PPTX);
  const module = await import('officeparser');
  const parseOffice = module.parseOffice ?? module.default?.parseOffice;
  if (typeof parseOffice !== 'function') throw new Error('PPTX parser unavailable');
  const ast = await parseOffice(buffer);
  return typeof ast?.toText === 'function' ? ast.toText() : '';
}

async function extractKeywordText(buffer, mimeType) {
  if (mimeType === MIME_PDF) {
    const result = await parsePdf(buffer, false);
    return clamp(result.text, MAX_KEYWORD_TEXT_CHARS).text;
  }
  if (mimeType === MIME_DOCX) {
    return clamp(await parseDocx(buffer), MAX_KEYWORD_TEXT_CHARS).text;
  }
  if (mimeType === MIME_PPTX) return parsePptxForKeywords(buffer);
  const error = new Error('Unsupported document type');
  error.code = 'unsupported_type';
  throw error;
}

async function extractAttachmentText(buffer, mimeType) {
  if (mimeType === MIME_PDF) {
    const result = await parsePdf(buffer, false);
    const clamped = clamp(result.text, MAX_ATTACHMENT_TEXT_CHARS, TRUNCATION_MARKER);
    return { ...clamped, pages: result.pages };
  }
  let raw;
  if (mimeType === MIME_DOCX) raw = await parseDocx(buffer);
  else if (mimeType === MIME_XLSX) raw = await parseXlsx(buffer);
  else if (mimeType === MIME_PPTX) raw = await parsePptxForAttachment(buffer);
  else if (mimeType === MIME_XLS) {
    // Preserve the prior behavior: BIFF .xls was advertised but the ExcelJS
    // path only accepted OOXML and rejected it as a non-ZIP document.
    await preflightOffice(buffer, MIME_XLS);
    throw new Error('Legacy XLS is not supported by the configured parser');
  } else {
    const error = new Error('Unsupported document type');
    error.code = 'unsupported_type';
    throw error;
  }
  return clamp(raw, MAX_ATTACHMENT_TEXT_CHARS, TRUNCATION_MARKER);
}

async function main() {
  const operation = process.argv[2];
  const mimeType = String(process.argv[3] ?? '').toLowerCase();
  const buffer = await readInput();

  if (operation === 'pdf-info' && mimeType === MIME_PDF) {
    return parsePdf(buffer, true);
  }
  if (operation === 'keyword-text') {
    return { text: await extractKeywordText(buffer, mimeType) };
  }
  if (operation === 'attachment-text') {
    return extractAttachmentText(buffer, mimeType);
  }
  const error = new Error('Unsupported parser operation');
  error.code = 'unsupported_type';
  throw error;
}

try {
  writeResponse({ ok: true, value: await main() });
} catch (error) {
  writeResponse({ ok: false, error: safeError(error) });
  process.exitCode = 1;
}
