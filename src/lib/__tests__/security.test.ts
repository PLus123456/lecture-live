import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  assertWithinRoot,
  assertOwnership,
  parseExportFormat,
  parsePositiveInteger,
  parseStorageCategory,
  sanitizeHeaderFilename,
  sanitizePath,
  sanitizeTextInput,
  sanitizeToken,
} from '@/lib/security';

describe('security helpers', () => {
  it('清洗路径和 token 输入', () => {
    expect(sanitizePath('../../secret?.txt')).toBe('secret_.txt');
    expect(sanitizeToken('token-123_abc!!')).toBe('token-123_abc');
  });

  it('处理非法路径、回退文件名与文本输入', () => {
    expect(() => sanitizePath('')).toThrow('Invalid path input');
    expect(sanitizeHeaderFilename('')).toBe('download.bin');
    expect(sanitizeTextInput('  hello world  ', { maxLength: 5 })).toBe('hello');
    expect(sanitizeTextInput('   ', { fallback: 'fallback' })).toBe('fallback');
  });

  it('校验导出格式与整数输入', () => {
    expect(parseExportFormat('json')).toBe('json');
    expect(parsePositiveInteger('12', { min: 1, max: 20 })).toBe(12);
    expect(() => parseExportFormat('pdf')).toThrow('Invalid export format');
    expect(parsePositiveInteger('', { defaultValue: 7 })).toBe(7);
    expect(() => parsePositiveInteger('x')).toThrow('Invalid integer input');
    expect(() => parsePositiveInteger('0', { min: 1 })).toThrow('below minimum');
    expect(() => parsePositiveInteger('99', { max: 10 })).toThrow('above maximum');
  });

  it('阻止越权访问根目录之外的路径', () => {
    const root = path.resolve('/tmp/lecture-live-root');
    expect(() =>
      assertWithinRoot(path.resolve(root, 'nested/file.txt'), root)
    ).not.toThrow();
    expect(() =>
      assertWithinRoot(path.resolve(root, '../outside.txt'), root)
    ).toThrow('Path traversal detected');
  });

  it('校验存储分类与资源归属', () => {
    expect(parseStorageCategory('recordings')).toBe('recordings');
    expect(() => parseStorageCategory('reports')).toThrow('Invalid storage category');
    expect(() => assertOwnership('user-a', 'user-b')).toThrow('Access denied');
  });
});
