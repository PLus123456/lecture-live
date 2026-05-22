import { describe, expect, it } from 'vitest';
import {
  validateChatFileCleanupParams,
  CHAT_FILE_CLEANUP_DAYS_MIN,
  CHAT_FILE_CLEANUP_DAYS_MAX,
} from '@/lib/chatFileCleanup';

describe('validateChatFileCleanupParams', () => {
  it('最小参数（只给 olderThanDays）通过校验，其余字段填默认空值', () => {
    const result = validateChatFileCleanupParams({ olderThanDays: 14 });
    expect(result.ok).toBe(true);
    expect(result.olderThanDays).toBe(14);
    expect(result.sizeBytesGT).toBe(0);
    expect(result.userId).toBeUndefined();
    expect(result.conversationId).toBeUndefined();
    expect(result.kinds).toEqual([]);
  });

  it.each([
    [0, '低于下限'],
    [-1, '负数'],
    [1.5, '非整数'],
    [CHAT_FILE_CLEANUP_DAYS_MAX + 1, '高于上限'],
    [NaN, 'NaN'],
    [undefined, 'undefined'],
  ] as Array<[number | undefined, string]>)(
    'olderThanDays = %s 被拒绝 (%s)',
    (days) => {
      const result = validateChatFileCleanupParams({ olderThanDays: days });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/olderThanDays/);
    }
  );

  it('边界天数 1 和 365 都接受', () => {
    expect(validateChatFileCleanupParams({ olderThanDays: CHAT_FILE_CLEANUP_DAYS_MIN }).ok).toBe(true);
    expect(validateChatFileCleanupParams({ olderThanDays: CHAT_FILE_CLEANUP_DAYS_MAX }).ok).toBe(true);
  });

  it('sizeBytesGT 负数 clamp 到 0，浮点数取整', () => {
    expect(validateChatFileCleanupParams({ olderThanDays: 14, sizeBytesGT: -100 }).sizeBytesGT).toBe(0);
    expect(validateChatFileCleanupParams({ olderThanDays: 14, sizeBytesGT: 1023.7 }).sizeBytesGT).toBe(1023);
  });

  it('kinds 接受已知三种值', () => {
    const result = validateChatFileCleanupParams({
      olderThanDays: 14,
      kinds: ['image', 'document', 'text'],
    });
    expect(result.ok).toBe(true);
    expect(result.kinds).toEqual(['image', 'document', 'text']);
  });

  it('kinds 出现未知种类时拒绝（白名单）', () => {
    const result = validateChatFileCleanupParams({
      olderThanDays: 14,
      kinds: ['image', 'video'],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/未知附件种类/);
  });

  it('kinds 重复值会被去重', () => {
    const result = validateChatFileCleanupParams({
      olderThanDays: 14,
      kinds: ['image', 'image', 'document'],
    });
    expect(result.ok).toBe(true);
    expect(result.kinds).toEqual(['image', 'document']);
  });

  it('kinds 中含非字符串项被拒绝', () => {
    const result = validateChatFileCleanupParams({
      olderThanDays: 14,
      kinds: ['image', 123 as unknown as string],
    });
    expect(result.ok).toBe(false);
  });

  it('空字符串的 userId / conversationId 被视为 undefined（不当过滤）', () => {
    const result = validateChatFileCleanupParams({
      olderThanDays: 14,
      userId: '',
      conversationId: '',
    });
    expect(result.ok).toBe(true);
    expect(result.userId).toBeUndefined();
    expect(result.conversationId).toBeUndefined();
  });

  it('合法 userId / conversationId 保留传出', () => {
    const result = validateChatFileCleanupParams({
      olderThanDays: 14,
      userId: 'user-abc',
      conversationId: 'conv-xyz',
    });
    expect(result.userId).toBe('user-abc');
    expect(result.conversationId).toBe('conv-xyz');
  });
});
