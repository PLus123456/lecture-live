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

  it('尽量保留中文与其他 Unicode 字母数字', () => {
    expect(sanitizeFileNamePart('高数第一讲')).toBe('高数第一讲');
    expect(sanitizeFileNamePart('../../课程/第一讲?')).toBe('第一讲_');
    expect(sanitizeDownloadFilenameBase('résumé 2026')).toBe('résumé_2026');
  });

  it('在文件名非法时回退到默认值', () => {
    expect(() => sanitizeFileNamePart('')).toThrow('Invalid path input');
    expect(sanitizeDownloadFilenameBase('', 'lecture-export')).toBe('lecture-export');
  });
});
