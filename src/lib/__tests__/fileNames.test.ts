import { describe, expect, it } from 'vitest';
import {
  sanitizeDownloadFilenameBase,
  sanitizeFileNamePart,
} from '@/lib/fileNames';

describe('file name helpers', () => {
  it('清洗下载文件名并阻止目录穿越', () => {
    expect(sanitizeFileNamePart('../../week 1:intro')).toBe('week_1_intro');
    expect(sanitizeDownloadFilenameBase('course/math?')).toBe('math_');
  });

  it('在文件名非法时回退到默认值', () => {
    expect(() => sanitizeFileNamePart('')).toThrow('Invalid path input');
    expect(sanitizeDownloadFilenameBase('', 'lecture-export')).toBe('lecture-export');
  });
});
