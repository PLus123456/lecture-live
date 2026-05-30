import { describe, expect, it } from 'vitest';
import {
  resolveBillableInterpretMs,
  MAX_INTERPRET_DURATION_MS,
} from '@/lib/interpret/anchor';

describe('resolveBillableInterpretMs', () => {
  const now = 1_000_000_000_000;

  it('无锚点时降级信任前端时长，并封顶到硬上限', () => {
    expect(
      resolveBillableInterpretMs({ frontendMs: 120_000, anchorStartedAt: null, now })
    ).toEqual({ effectiveMs: 120_000, mismatch: false, anchored: false });

    expect(
      resolveBillableInterpretMs({
        frontendMs: MAX_INTERPRET_DURATION_MS + 60_000,
        anchorStartedAt: null,
        now,
      })
    ).toEqual({
      effectiveMs: MAX_INTERPRET_DURATION_MS,
      mismatch: false,
      anchored: false,
    });
  });

  it('容差内采纳前端时长', () => {
    // 服务端墙钟 120s，前端报 118s（在 60s 容差内）
    const result = resolveBillableInterpretMs({
      frontendMs: 118_000,
      anchorStartedAt: now - 120_000,
      now,
    });
    expect(result).toEqual({ effectiveMs: 118_000, mismatch: false, anchored: true });
  });

  it('明显少报时按服务端墙钟扣费并标记 mismatch', () => {
    // 服务端墙钟 1h，前端只报 1min
    const result = resolveBillableInterpretMs({
      frontendMs: 60_000,
      anchorStartedAt: now - 3_600_000,
      now,
    });
    expect(result.anchored).toBe(true);
    expect(result.mismatch).toBe(true);
    expect(result.effectiveMs).toBe(3_600_000);
  });

  it('前端多报时封顶到服务端墙钟，不标 mismatch', () => {
    const result = resolveBillableInterpretMs({
      frontendMs: 600_000,
      anchorStartedAt: now - 120_000,
      now,
    });
    expect(result).toEqual({ effectiveMs: 120_000, mismatch: false, anchored: true });
  });

  it('服务端墙钟超硬上限时封顶', () => {
    const result = resolveBillableInterpretMs({
      frontendMs: MAX_INTERPRET_DURATION_MS + 1_000_000,
      anchorStartedAt: now - (MAX_INTERPRET_DURATION_MS + 2_000_000),
      now,
    });
    expect(result.effectiveMs).toBe(MAX_INTERPRET_DURATION_MS);
    expect(result.anchored).toBe(true);
  });
});
