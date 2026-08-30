import fs from 'node:fs/promises';

const EBML_HEADER = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const EBML_DOC_TYPES = [Buffer.from('webm'), Buffer.from('matroska')] as const;
const DOC_TYPE_LOOKAHEAD_BYTES = 132;
const SCAN_CHUNK_BYTES = 1024 * 1024;

/** Each document is independently probed and decoded, so keep process fan-out tightly bounded. */
export const MAX_AUTHORITATIVE_WEBM_DOCUMENTS = 64;
/** Also cap bogus EBML-header candidates that do not contain a WebM DocType. */
const MAX_EBML_HEADER_CANDIDATES = 4096;

export interface WebmDocumentRange {
  start: number;
  end: number;
}

export class WebmDocumentScanError extends Error {
  constructor(message = 'Could not safely identify WebM document boundaries') {
    super(message);
    this.name = 'WebmDocumentScanError';
  }
}

/**
 * Scan a potentially concatenated WebM/MKV using fixed-size reads. MediaRecorder restarts create
 * independent EBML documents whose timestamps and track tables also restart; treating the bytes as
 * one ffmpeg input can silently ignore later documents. Only offsets are retained in memory.
 */
export async function scanWebmDocumentRanges(
  filePath: string
): Promise<WebmDocumentRange[]> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const fileSize = stat.size;
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
      throw new WebmDocumentScanError();
    }

    const offsets: number[] = [];
    let candidateCount = 0;
    let position = 0;
    let nextScanGlobal = 0;
    let carry = Buffer.alloc(0);

    while (position < fileSize) {
      const requested = Math.min(SCAN_CHUNK_BYTES, fileSize - position);
      const block = Buffer.allocUnsafe(requested);
      const { bytesRead } = await handle.read(block, 0, requested, position);
      if (bytesRead <= 0) throw new WebmDocumentScanError();

      const chunk = block.subarray(0, bytesRead);
      const combinedStart = position - carry.length;
      const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      const availableEnd = position + bytesRead;
      const isFinal = availableEnd >= fileSize;
      const maxCandidateGlobal = isFinal
        ? fileSize - EBML_HEADER.length
        : availableEnd - DOC_TYPE_LOOKAHEAD_BYTES;

      let searchFrom = Math.max(0, nextScanGlobal - combinedStart);
      while (searchFrom <= combined.length - EBML_HEADER.length) {
        const localOffset = combined.indexOf(EBML_HEADER, searchFrom);
        if (localOffset < 0) break;
        const globalOffset = combinedStart + localOffset;
        if (globalOffset > maxCandidateGlobal) break;

        candidateCount += 1;
        if (candidateCount > MAX_EBML_HEADER_CANDIDATES) {
          throw new WebmDocumentScanError('Too many EBML header candidates');
        }

        const docTypeEnd = Math.min(
          combined.length,
          localOffset + DOC_TYPE_LOOKAHEAD_BYTES
        );
        const hasAllowedDocType = EBML_DOC_TYPES.some((docType) => {
          const docTypeOffset = combined.indexOf(
            docType,
            localOffset + EBML_HEADER.length
          );
          return (
            docTypeOffset >= 0 && docTypeOffset + docType.length <= docTypeEnd
          );
        });
        if (hasAllowedDocType) {
          offsets.push(globalOffset);
          if (offsets.length > MAX_AUTHORITATIVE_WEBM_DOCUMENTS) {
            throw new WebmDocumentScanError('Too many concatenated WebM documents');
          }
        }
        searchFrom = localOffset + 1;
      }

      nextScanGlobal = Math.max(nextScanGlobal, maxCandidateGlobal + 1);
      const carryBytes = Math.min(
        DOC_TYPE_LOOKAHEAD_BYTES - 1,
        combined.length
      );
      carry = Buffer.from(combined.subarray(combined.length - carryBytes));
      position = availableEnd;
    }

    // validateMediaContainer has already required EBML magic at byte zero. If the stricter scan
    // cannot confirm the first document there, do not fall back to whole-file ffmpeg semantics.
    if (offsets.length === 0 || offsets[0] !== 0) {
      throw new WebmDocumentScanError();
    }

    return offsets.map((start, index) => ({
      start,
      end: offsets[index + 1] ?? fileSize,
    }));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Copy exactly one document range with constant heap and exclusive destination creation. */
export async function copyFileRange(
  sourcePath: string,
  range: WebmDocumentRange,
  destinationPath: string
): Promise<void> {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end <= range.start
  ) {
    throw new WebmDocumentScanError();
  }

  const source = await fs.open(sourcePath, 'r');
  let destination: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    destination = await fs.open(destinationPath, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    let readPosition = range.start;
    while (readPosition < range.end) {
      const requested = Math.min(buffer.length, range.end - readPosition);
      const { bytesRead } = await source.read(
        buffer,
        0,
        requested,
        readPosition
      );
      if (bytesRead <= 0) throw new WebmDocumentScanError();

      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written
        );
        if (result.bytesWritten <= 0) throw new WebmDocumentScanError();
        written += result.bytesWritten;
      }
      readPosition += bytesRead;
    }
    // close may be where a delayed filesystem write/flush error surfaces. Propagate it on the
    // success path; otherwise ffmpeg could measure a valid prefix of a silently truncated range.
    await destination.close();
    destination = null;
  } finally {
    // If an earlier read/write/close already failed, cleanup must not replace that primary error.
    await destination?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}
