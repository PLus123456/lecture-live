import fs from 'fs/promises';

const READ_CHUNK_BYTES = 64 * 1024;

export class BoundedJsonFileError extends Error {
  constructor(
    message: string,
    readonly code: 'FILE_TOO_LARGE' | 'INVALID_JSON'
  ) {
    super(message);
    this.name = 'BoundedJsonFileError';
  }
}

/**
 * 在分配/解析前执行硬字节上限的 JSON 文件读取。
 *
 * 不能只 stat 后直接 readFile：文件可在 stat 与读取之间增长，仍会造成无界分配。这里
 * 最多读取 maxBytes+1 个字节，既能识别增长竞态，又让进程内存峰值由调用方上限决定。
 */
export async function readJsonFileBounded(
  filePath: string,
  maxBytes: number
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }

  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size > maxBytes) {
      throw new BoundedJsonFileError(
        `JSON file exceeds ${maxBytes} bytes`,
        'FILE_TOO_LARGE'
      );
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let position = 0;
    while (totalBytes <= maxBytes) {
      const remaining = maxBytes + 1 - totalBytes;
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position
      );
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
      position += bytesRead;
    }

    if (totalBytes > maxBytes) {
      throw new BoundedJsonFileError(
        `JSON file exceeds ${maxBytes} bytes`,
        'FILE_TOO_LARGE'
      );
    }

    try {
      return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'));
    } catch {
      throw new BoundedJsonFileError('JSON file is invalid', 'INVALID_JSON');
    }
  } finally {
    await handle.close();
  }
}
