import { describe, expect, it } from 'vitest';
import {
  clampSessionDurationMs,
  getBillableMinutes,
  getMaxSessionDurationMs,
  getNextQuotaResetAt,
  getQuotaCycleStartAt,
  getRemainingTranscriptionMinutes,
  getRemainingTranscriptionMs,
} from '@/lib/billing';

describe('billing helpers', () => {
  it('按用户角色限制 session 时长', () => {
    expect(clampSessionDurationMs(5 * 60 * 60_000, 'FREE')).toBe(2 * 60 * 60_000);
    expect(clampSessionDurationMs(5 * 60 * 60_000, 'PRO')).toBe(4 * 60 * 60_000);
    expect(clampSessionDurationMs(5 * 60 * 60_000, 'ADMIN')).toBe(5 * 60 * 60_000);
  });

  it('向上取整计费分钟数', () => {
    expect(getBillableMinutes(0)).toBe(0);
    expect(getBillableMinutes(1)).toBe(1);
    expect(getBillableMinutes(61_000)).toBe(2);
  });

  it('使用 UTC 计算下一个配额重置时间', () => {
    const base = new Date('2026-03-27T13:45:00.000Z');
    expect(getNextQuotaResetAt(base).toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('能反推出当前配额周期开始时间', () => {
    const resetAt = new Date('2026-04-01T00:00:00.000Z');
    expect(getQuotaCycleStartAt(resetAt).toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('剩余转录分钟不会出现负数', () => {
    expect(getRemainingTranscriptionMinutes(10, 60)).toBe(50);
    expect(getRemainingTranscriptionMinutes(100, 60)).toBe(0);
    expect(getRemainingTranscriptionMinutes(10, 0)).toBe(0);
    expect(getRemainingTranscriptionMs(10, 60)).toBe(50 * 60_000);
  });

  it('处理空配额周期和非法时长', () => {
    expect(getMaxSessionDurationMs('ADMIN')).toBeNull();
    expect(getMaxSessionDurationMs('FREE')).toBe(2 * 60 * 60_000);
    expect(clampSessionDurationMs(Number.NaN, 'FREE')).toBe(0);
    expect(getBillableMinutes(-1)).toBe(0);
    expect(getQuotaCycleStartAt(null).toISOString()).toBe(new Date(0).toISOString());
  });
});
