import { describe, expect, it } from 'vitest';
import {
  clampSessionDurationMs,
  getBillableMinutes,
  getMaxSessionDurationMs,
  getNextQuotaResetAt,
  getQuotaCycleStartAt,
  getRemainingTranscriptionMinutes,
  getRemainingTranscriptionMs,
  STREAM_DURATION_CAP_GRACE_MS,
  sumCappedStreamActualMs,
  withMeasuredStreamFloorMs,
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

describe('withMeasuredStreamFloorMs / sumCappedStreamActualMs', () => {
  it('实测不超过「上限 + 15 分钟宽限」→ 计费不变；超出部分按「实测 − 宽限」计', () => {
    const twoHours = 2 * 60 * 60_000;
    expect(withMeasuredStreamFloorMs(twoHours, twoHours + 15 * 60_000)).toBe(twoHours);
    expect(withMeasuredStreamFloorMs(twoHours, 3 * 60 * 60_000)).toBe(165 * 60_000);
    expect(withMeasuredStreamFloorMs(40 * 60_000, 0)).toBe(40 * 60_000);
    expect(withMeasuredStreamFloorMs(40 * 60_000, Number.NaN)).toBe(40 * 60_000);
    expect(STREAM_DURATION_CAP_GRACE_MS).toBe(15 * 60_000);
  });

  it('实测逐条封顶到各自的连接硬上限再求和', () => {
    expect(
      sumCappedStreamActualMs([
        { actualMs: 9 * 60 * 60_000, maxSessionSeconds: 900 },
        { actualMs: 120_000, maxSessionSeconds: 900 },
        { actualMs: null, maxSessionSeconds: 900 },
        { actualMs: -5, maxSessionSeconds: 900 },
      ])
    ).toBe(900_000 + 120_000);
  });
});
