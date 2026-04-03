/**
 * 清洗文件名片段，兼容浏览器下载名与 ZIP 条目名。
 * 这里不依赖 Node.js path，方便在客户端直接复用。
 */
export function sanitizeFileNamePart(input: string): string {
  if (!input || typeof input !== 'string') {
    throw new Error('Invalid path input');
  }

  let safe = input.replace(/\0/g, '');

  // 只保留最后一个 path segment，避免把标题解释成目录结构。
  const parts = safe.split(/[/\\]+/);
  safe = parts[parts.length - 1] ?? '';

  safe = safe.replace(/\.\./g, '').replace(/[/\\]/g, '');
  safe = safe.replace(/[^\p{L}\p{N}\p{M}._-]/gu, '_');

  if (!safe || safe === '.' || safe === '..') {
    throw new Error('Invalid path after sanitization');
  }

  if (safe.length > 255) {
    safe = safe.slice(0, 255);
  }

  return safe;
}

export function sanitizeDownloadFilenameBase(
  input: string,
  fallback = 'lecture'
): string {
  try {
    return sanitizeFileNamePart(input);
  } catch {
    return fallback;
  }
}
