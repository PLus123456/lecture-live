import path from 'path';
import { sanitizeFileNamePart } from '@/lib/fileNames';

export const STORAGE_CATEGORIES = [
  'recordings',
  'transcripts',
  'summaries',
] as const;

export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

const STORAGE_CATEGORY_SET = new Set<string>(STORAGE_CATEGORIES);

export const EXPORT_FORMATS = ['markdown', 'srt', 'json', 'txt'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
const EXPORT_FORMAT_SET = new Set<string>(EXPORT_FORMATS);

/**
 * 清洗文件名和路径，防止路径穿越攻击
 * 移除 .., /, \, null bytes, 以及其他危险字符
 */
export function sanitizePath(input: string): string {
  if (!input || typeof input !== 'string') {
    throw new Error('Invalid path input');
  }

  return sanitizeFileNamePart(path.basename(input));
}

export function sanitizeToken(input: string): string {
  if (!input || typeof input !== 'string') {
    throw new Error('Invalid token input');
  }

  const safe = input.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) {
    throw new Error('Invalid token');
  }

  return safe;
}

export function sanitizeHeaderFilename(input: string, fallback = 'download.bin'): string {
  try {
    return sanitizePath(input);
  } catch {
    return fallback;
  }
}

export function sanitizeTextInput(
  input: string,
  options?: { maxLength?: number; fallback?: string }
): string {
  const fallback = options?.fallback ?? '';
  if (typeof input !== 'string') {
    return fallback;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return fallback;
  }

  return options?.maxLength ? trimmed.slice(0, options.maxLength) : trimmed;
}

export function parseStorageCategory(input: string | null | undefined): StorageCategory {
  if (!input || !STORAGE_CATEGORY_SET.has(input)) {
    throw new Error('Invalid storage category');
  }

  return input as StorageCategory;
}

export function parseExportFormat(input: string | null | undefined): ExportFormat {
  if (!input || !EXPORT_FORMAT_SET.has(input)) {
    throw new Error('Invalid export format');
  }

  return input as ExportFormat;
}

export function parsePositiveInteger(
  input: unknown,
  options?: { min?: number; max?: number; defaultValue?: number }
): number {
  if (input == null || input === '') {
    if (options?.defaultValue != null) {
      return options.defaultValue;
    }
    throw new Error('Missing integer input');
  }

  const value =
    typeof input === 'number' ? input : Number.parseInt(String(input), 10);
  if (!Number.isFinite(value)) {
    throw new Error('Invalid integer input');
  }

  const normalized = Math.trunc(value);
  if (options?.min != null && normalized < options.min) {
    throw new Error('Integer input below minimum');
  }
  if (options?.max != null && normalized > options.max) {
    throw new Error('Integer input above maximum');
  }

  return normalized;
}

/**
 * 验证完整路径是否在允许的根目录内
 */
export function assertWithinRoot(fullPath: string, rootDir: string): void {
  const resolved = path.resolve(fullPath);
  const resolvedRoot = path.resolve(rootDir);

  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    throw new Error(`Path traversal detected: ${fullPath} is outside ${rootDir}`);
  }
}

/**
 * 验证用户是否有权访问指定 userId 的资源
 */
export function assertOwnership(requestUserId: string, resourceUserId: string): void {
  if (requestUserId !== resourceUserId) {
    throw new Error('Access denied: resource does not belong to current user');
  }
}
