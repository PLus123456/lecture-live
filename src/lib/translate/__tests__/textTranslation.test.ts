// 句子翻译支撑件单测：prompt 硬约束、每日免费额度（内存兜底路径：Redis 不可用）。
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/redis', () => ({ getRedisClient: () => null }));

import {
  buildTextTranslationPrompt,
  consumeDailyTextQuota,
  releaseDailyTextQuota,
} from '@/lib/translate/textTranslation';

describe('buildTextTranslationPrompt', () => {
  it('auto 源语走自动检测措辞，只输出译文的硬约束在 system 里', () => {
    const { system, user } = buildTextTranslationPrompt('Hello', 'auto', 'zh');
    expect(system).toContain('Auto-detect the source language');
    expect(system).toContain('Chinese (Simplified)');
    expect(system).toContain('Output ONLY the translated text');
    expect(user).toBe('Hello');
  });

  it('具体源语按全名注入；未知代码原样传', () => {
    const { system } = buildTextTranslationPrompt('x', 'ja', 'tlh');
    expect(system).toContain('Japanese');
    expect(system).toContain('into tlh');
  });
});

describe('consumeDailyTextQuota（内存兜底）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('limit<=0 视为不限', async () => {
    const result = await consumeDailyTextQuota('u-unlimited', 0);
    expect(result).toEqual({ allowed: true, used: 0, limit: 0 });
  });

  it('额度耗尽后拒绝，release 归还一次后可再用', async () => {
    const uid = `u-${Math.random().toString(36).slice(2)}`;
    expect((await consumeDailyTextQuota(uid, 2)).allowed).toBe(true);
    expect((await consumeDailyTextQuota(uid, 2)).allowed).toBe(true);
    expect((await consumeDailyTextQuota(uid, 2)).allowed).toBe(false);

    await releaseDailyTextQuota(uid);
    expect((await consumeDailyTextQuota(uid, 2)).allowed).toBe(true);
    expect((await consumeDailyTextQuota(uid, 2)).allowed).toBe(false);
  });
});
