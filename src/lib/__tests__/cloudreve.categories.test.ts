import { describe, it, expect } from 'vitest';
import { isStorageCategory } from '@/lib/storage/cloudreve';

describe('isStorageCategory', () => {
  it('accepts the new chat-uploads category', () => {
    expect(isStorageCategory('chat-uploads')).toBe(true);
  });
  it('still accepts legacy categories', () => {
    expect(isStorageCategory('recordings')).toBe(true);
    expect(isStorageCategory('reports')).toBe(true);
  });
  it('rejects unknown values', () => {
    expect(isStorageCategory('uploads')).toBe(false);
  });
});
