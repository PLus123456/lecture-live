import { isUtf8 } from 'node:buffer';
import { createInflateRaw, crc32 } from 'node:zlib';

export const ZIP_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxCentralDirectoryBytes: 16 * 1024 * 1024,
  maxEntryNameBytes: 1024,
  maxTotalEntryNameBytes: 1024 * 1024,
  maxPathDepth: 32,
  maxExtraFieldBytes: 16 * 1024,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxCompressionRatio: 100,
  compressionRatioGraceBytes: 1024 * 1024,
});

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const MAX_EOCD_SEARCH_BYTES = 65_535 + 22;
const UTF8_FLAG = 1 << 11;
const ENCRYPTED_FLAG = 1;
const ALLOWED_COMPRESSION_METHODS = new Set([0, 8]);

export class UnsafeDocumentArchiveError extends Error {
  constructor(message, code = 'invalid_archive') {
    super(message);
    this.name = 'UnsafeDocumentArchiveError';
    this.code = code;
  }
}

function reject(message, code = 'invalid_archive') {
  throw new UnsafeDocumentArchiveError(message, code);
}

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - MAX_EOCD_SEARCH_BYTES);
  let match = -1;
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentBytes = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentBytes !== buffer.length) continue;
    if (match !== -1) reject('Invalid ZIP: ambiguous end of central directory');
    match = offset;
  }
  if (match !== -1) return match;
  reject('Invalid ZIP: end of central directory not found');
}

function inspectExtraFields(buffer, offset, length, limits) {
  if (length > limits.maxExtraFieldBytes) {
    reject('ZIP extra field exceeds its byte limit', 'archive_limit');
  }
  const end = offset + length;
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) reject('ZIP extra field is truncated');
    const id = buffer.readUInt16LE(cursor);
    const size = buffer.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + size > end) reject('ZIP extra field payload is truncated');
    if (id === 0x0001) reject('ZIP64 extra fields are not accepted');
    if (id === 0x7075) {
      reject('ZIP Unicode path override fields are not accepted');
    }
    cursor += size;
  }
}

function decodeEntryName(nameBytes, flags) {
  if (nameBytes.length === 0) reject('Invalid ZIP: empty entry name');
  if (nameBytes.length > ZIP_LIMITS.maxEntryNameBytes) {
    reject('ZIP entry path is too long', 'archive_limit');
  }
  if (nameBytes.includes(0)) reject('ZIP entry path contains NUL');
  if ((flags & UTF8_FLAG) === 0 && nameBytes.some((value) => value >= 0x80)) {
    reject('ZIP entry path must be ASCII or explicitly UTF-8');
  }
  if ((flags & UTF8_FLAG) !== 0 && !isUtf8(nameBytes)) {
    reject('ZIP entry path is not valid UTF-8');
  }
  return nameBytes.toString('utf8');
}

function assertSafeEntryPath(name, limits) {
  if (
    name.startsWith('/') ||
    name.startsWith('\\') ||
    /^[A-Za-z]:/u.test(name) ||
    name.includes('\\')
  ) {
    reject('ZIP entry path must be relative and use forward slashes');
  }
  if (/[/\u0000-\u001f\u007f]/u.test(name.slice(-1)) && !name.endsWith('/')) {
    reject('ZIP entry path contains control characters');
  }
  if (/[\u0000-\u001f\u007f]/u.test(name)) {
    reject('ZIP entry path contains control characters');
  }

  const segments = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    reject('ZIP entry path contains an unsafe segment');
  }
  if (segments.length > limits.maxPathDepth) {
    reject('ZIP entry path is too deep', 'archive_limit');
  }
}

function assertRatio(uncompressed, compressed, label, limits) {
  if (uncompressed === 0) return;
  if (compressed === 0) {
    reject(`${label} has zero compressed bytes`, 'archive_limit');
  }
  const allowed =
    BigInt(compressed) * BigInt(limits.maxCompressionRatio) +
    BigInt(limits.compressionRatioGraceBytes);
  if (BigInt(uncompressed) > allowed) {
    reject(`${label} exceeds the compression ratio limit`, 'archive_limit');
  }
}

function assertLocalHeader(buffer, entry, centralOffset, limits) {
  const offset = entry.localHeaderOffset;
  if (offset < 0 || offset + 30 > centralOffset) {
    reject('ZIP local header points outside the archive');
  }
  if (buffer.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    reject('ZIP local header signature is invalid');
  }
  const localFlags = buffer.readUInt16LE(offset + 6);
  const localCompressionMethod = buffer.readUInt16LE(offset + 8);
  const localCrc32 = buffer.readUInt32LE(offset + 14);
  const localCompressedSize = buffer.readUInt32LE(offset + 18);
  const localUncompressedSize = buffer.readUInt32LE(offset + 22);
  if (localFlags !== entry.flags || localCompressionMethod !== entry.compressionMethod) {
    reject('ZIP local and central compression metadata disagree');
  }
  // With a data descriptor (bit 3) the local sizes may intentionally be zero;
  // otherwise both representations must agree exactly.
  if (
    (localFlags & (1 << 3)) === 0 &&
    (localCompressedSize !== entry.compressedSize ||
      localUncompressedSize !== entry.uncompressedSize)
  ) {
    reject('ZIP local and central size metadata disagree');
  }
  const localNameBytes = buffer.readUInt16LE(offset + 26);
  const localExtraBytes = buffer.readUInt16LE(offset + 28);
  const payloadOffset = offset + 30 + localNameBytes + localExtraBytes;
  if (payloadOffset > centralOffset || payloadOffset + entry.compressedSize > centralOffset) {
    reject('ZIP entry payload points outside the local file area');
  }
  const localName = buffer.subarray(offset + 30, offset + 30 + localNameBytes);
  if (!localName.equals(entry.rawName)) {
    reject('ZIP local and central entry paths disagree');
  }
  inspectExtraFields(
    buffer,
    offset + 30 + localNameBytes,
    localExtraBytes,
    limits
  );

  let recordEnd = payloadOffset + entry.compressedSize;
  if ((localFlags & (1 << 3)) === 0) {
    if (localCrc32 !== entry.crc32) {
      reject('ZIP local and central CRC metadata disagree');
    }
  } else {
    let descriptorOffset = recordEnd;
    if (descriptorOffset + 12 > centralOffset) {
      reject('ZIP data descriptor is truncated');
    }
    if (buffer.readUInt32LE(descriptorOffset) === DATA_DESCRIPTOR_SIGNATURE) {
      descriptorOffset += 4;
    }
    if (descriptorOffset + 12 > centralOffset) {
      reject('ZIP data descriptor is truncated');
    }
    const descriptorCrc32 = buffer.readUInt32LE(descriptorOffset);
    const descriptorCompressed = buffer.readUInt32LE(descriptorOffset + 4);
    const descriptorUncompressed = buffer.readUInt32LE(descriptorOffset + 8);
    if (
      descriptorCrc32 !== entry.crc32 ||
      descriptorCompressed !== entry.compressedSize ||
      descriptorUncompressed !== entry.uncompressedSize
    ) {
      reject('ZIP data descriptor disagrees with the central directory');
    }
    recordEnd = descriptorOffset + 12;
  }
  return {
    start: offset,
    end: recordEnd,
    dataOffset: payloadOffset,
    dataEnd: payloadOffset + entry.compressedSize,
  };
}

/**
 * Scan raw ZIP central-directory records before JSZip or any Office parser sees
 * attacker-controlled bytes. The scan is bounded by entry count and central
 * directory size and never inflates file data.
 */
export function inspectDocumentArchive(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) reject('ZIP input must be a Buffer');
  const limits = { ...ZIP_LIMITS, ...(options.limits ?? {}) };
  const eocdOffset = findEndOfCentralDirectory(buffer);

  if (
    (eocdOffset >= 20 &&
      buffer.readUInt32LE(eocdOffset - 20) === ZIP64_LOCATOR_SIGNATURE) ||
    (eocdOffset >= 56 &&
      buffer.readUInt32LE(eocdOffset - 56) === ZIP64_EOCD_SIGNATURE)
  ) {
    reject('ZIP64 archives are not accepted by the document parser');
  }

  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralBytes = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (
    entryCount === 0xffff ||
    entriesOnDisk === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    reject('ZIP64 archives are not accepted by the document parser');
  }
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount
  ) {
    reject('Multi-disk ZIP archives are not accepted');
  }
  if (entryCount === 0) reject('ZIP archive is empty');
  if (entryCount > limits.maxEntries) {
    reject(`ZIP entry count exceeds limit (${limits.maxEntries})`, 'archive_limit');
  }
  if (centralBytes > limits.maxCentralDirectoryBytes) {
    reject('ZIP central directory exceeds its byte limit', 'archive_limit');
  }
  if (centralOffset + centralBytes !== eocdOffset) {
    reject('ZIP central directory bounds are inconsistent');
  }

  const names = new Set();
  const normalizedNames = new Set();
  const entries = [];
  let cursor = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let totalEntryNameBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocdOffset) reject('ZIP central directory is truncated');
    if (buffer.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
      reject('ZIP central directory entry signature is invalid');
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const entryCrc32 = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameBytes = buffer.readUInt16LE(cursor + 28);
    const extraBytes = buffer.readUInt16LE(cursor + 30);
    const commentBytes = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameBytes + extraBytes + commentBytes;

    if (recordEnd > eocdOffset) reject('ZIP central directory entry is truncated');
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      diskStart === 0xffff
    ) {
      reject('ZIP64 entries are not accepted by the document parser');
    }
    if (diskStart !== 0) reject('Multi-disk ZIP entries are not accepted');
    if ((flags & ENCRYPTED_FLAG) !== 0) reject('Encrypted ZIP entries are not accepted');
    if (!ALLOWED_COMPRESSION_METHODS.has(compressionMethod)) {
      reject('ZIP entry uses an unsupported compression method');
    }
    if (compressionMethod === 0 && compressedSize !== uncompressedSize) {
      reject('Stored ZIP entry has inconsistent sizes');
    }

    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameBytes);
    const name = decodeEntryName(rawName, flags);
    assertSafeEntryPath(name, limits);
    if (names.has(name)) reject('ZIP archive contains duplicate entry paths');
    names.add(name);
    const normalizedName = name.normalize('NFC').toLowerCase();
    if (normalizedNames.has(normalizedName)) {
      reject('ZIP archive contains ambiguous normalized entry paths');
    }
    normalizedNames.add(normalizedName);
    totalEntryNameBytes += nameBytes;
    if (totalEntryNameBytes > limits.maxTotalEntryNameBytes) {
      reject('ZIP entry paths exceed their aggregate byte limit', 'archive_limit');
    }
    inspectExtraFields(
      buffer,
      cursor + 46 + nameBytes,
      extraBytes,
      limits
    );

    // Unix symbolic-link mode in the upper 16 bits of external attributes.
    if (((externalAttributes >>> 16) & 0o170000) === 0o120000) {
      reject('ZIP symbolic-link entries are not accepted');
    }

    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    if (!Number.isSafeInteger(totalCompressed) || !Number.isSafeInteger(totalUncompressed)) {
      reject('ZIP size metadata exceeds safe integer range');
    }
    if (totalUncompressed > limits.maxUncompressedBytes) {
      reject(
        `Decompressed size exceeds limit (${limits.maxUncompressedBytes} bytes); refusing to parse (possible zip bomb)`,
        'archive_limit'
      );
    }
    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      reject(
        `ZIP entry ${name} exceeds the per-entry expanded byte limit`,
        'archive_limit'
      );
    }
    assertRatio(uncompressedSize, compressedSize, `ZIP entry ${name}`, limits);

    entries.push({
      name,
      rawName,
      flags,
      compressionMethod,
      crc32: entryCrc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor = recordEnd;
  }

  if (cursor !== eocdOffset) reject('ZIP central directory contains trailing records');
  assertRatio(totalUncompressed, totalCompressed, 'ZIP archive', limits);

  const ranges = entries
    .map((entry) => ({
      entry,
      range: assertLocalHeader(buffer, entry, centralOffset, limits),
    }))
    .sort((a, b) => a.range.start - b.range.start);
  if (ranges[0]?.range.start !== 0) {
    reject('ZIP archive contains an unsupported executable/prefix region');
  }
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].range.start !== ranges[index - 1].range.end) {
      reject('ZIP local entry ranges overlap or contain gaps');
    }
  }
  if (ranges.at(-1)?.range.end !== centralOffset) {
    reject('ZIP local file area contains trailing or hidden data');
  }

  for (const required of options.requiredEntries ?? []) {
    if (!names.has(required)) {
      reject(`OOXML archive is missing required part: ${required}`);
    }
  }

  return Object.freeze({
    entryCount,
    centralDirectoryBytes: centralBytes,
    totalCompressedBytes: totalCompressed,
    totalUncompressedBytes: totalUncompressed,
    entries: Object.freeze(
      ranges.map(({ entry, range }) =>
        Object.freeze({
          name: entry.name,
          compressionMethod: entry.compressionMethod,
          crc32: entry.crc32,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          dataOffset: range.dataOffset,
          dataEnd: range.dataEnd,
        })
      )
    ),
  });
}

async function inflateAndMeasure(buffer, entry, limits, remainingBytes) {
  const compressed = buffer.subarray(entry.dataOffset, entry.dataEnd);
  if (entry.compressionMethod === 0) {
    return {
      actualBytes: compressed.length,
      actualCrc32: crc32(compressed) >>> 0,
    };
  }

  const ratioLimit =
    entry.compressedSize * limits.maxCompressionRatio +
    limits.compressionRatioGraceBytes;
  const entryLimit = Math.min(
    limits.maxEntryUncompressedBytes,
    remainingBytes,
    ratioLimit
  );

  return await new Promise((resolve, reject) => {
    const inflater = createInflateRaw();
    let actualBytes = 0;
    let actualCrc32 = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(
        error instanceof UnsafeDocumentArchiveError
          ? error
          : new UnsafeDocumentArchiveError('ZIP entry DEFLATE stream is invalid')
      );
    };
    inflater.on('data', (chunk) => {
      if (settled) return;
      actualBytes += chunk.length;
      if (actualBytes > entryLimit) {
        const error = new UnsafeDocumentArchiveError(
          `ZIP entry ${entry.name} exceeds its actual inflate limit`,
          'archive_limit'
        );
        settled = true;
        inflater.destroy(error);
        reject(error);
        return;
      }
      actualCrc32 = crc32(chunk, actualCrc32) >>> 0;
    });
    inflater.once('error', fail);
    inflater.once('end', () => {
      if (settled) return;
      // zlib stops successfully at the first complete DEFLATE stream and can
      // otherwise ignore attacker-controlled trailing bytes inside the ZIP
      // member's declared compressed range. Reject that ambiguity before a
      // third-party parser gets a chance to interpret the same bytes
      // differently.
      if (inflater.bytesWritten !== compressed.length) {
        fail(
          new UnsafeDocumentArchiveError(
            'ZIP entry DEFLATE stream contains trailing compressed data'
          )
        );
        return;
      }
      settled = true;
      resolve({ actualBytes, actualCrc32 });
    });
    inflater.end(compressed);
  });
}

/**
 * In the restricted child, stream every DEFLATE member without retaining its
 * output. This detects forged central/local sizes and CRCs before any third-party
 * Office parser allocates an AST or materializes XML strings.
 */
export async function verifyDocumentArchiveInflation(
  buffer,
  report = inspectDocumentArchive(buffer),
  options = {}
) {
  const limits = { ...ZIP_LIMITS, ...(options.limits ?? {}) };
  let actualTotal = 0;
  let totalCompressed = 0;

  for (const entry of report.entries) {
    const remainingBytes = limits.maxUncompressedBytes - actualTotal;
    if (remainingBytes < 0) {
      reject('ZIP actual expanded bytes exceed the total limit', 'archive_limit');
    }
    const measured = await inflateAndMeasure(
      buffer,
      entry,
      limits,
      remainingBytes
    );
    if (measured.actualBytes !== entry.uncompressedSize) {
      reject('ZIP actual expanded size disagrees with its metadata');
    }
    if (measured.actualCrc32 !== entry.crc32) {
      reject('ZIP actual CRC disagrees with its metadata');
    }
    actualTotal += measured.actualBytes;
    totalCompressed += entry.compressedSize;
    if (actualTotal > limits.maxUncompressedBytes) {
      reject('ZIP actual expanded bytes exceed the total limit', 'archive_limit');
    }
  }

  assertRatio(actualTotal, totalCompressed, 'ZIP actual output', limits);
  return Object.freeze({
    actualUncompressedBytes: actualTotal,
    totalCompressedBytes: totalCompressed,
  });
}
