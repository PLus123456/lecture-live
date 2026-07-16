import { describe, expect, it } from 'vitest';
import {
  LIVE_SHARE_INTERNAL_MAX_SKEW_MS,
  signLiveShareRevalidatePayload,
  verifyLiveShareRevalidateSignature,
} from '@/lib/liveShare/internalApi';

// JWT_SECRET 由 vitest.setup.ts 注入，签名/验签走真实现。

describe('live share internal revalidate protocol', () => {
  const basePayload = {
    sessionId: 'session-1',
    mode: 'revoke' as const,
    ts: 1_800_000_000_000,
  };

  it('签名可通过验签（同 payload 同签名）', () => {
    const sig = signLiveShareRevalidatePayload(basePayload);
    expect(
      verifyLiveShareRevalidateSignature(basePayload, sig, basePayload.ts)
    ).toBe(true);
  });

  it('篡改任一字段后验签失败', () => {
    const sig = signLiveShareRevalidatePayload(basePayload);

    expect(
      verifyLiveShareRevalidateSignature(
        { ...basePayload, sessionId: 'session-2' },
        sig,
        basePayload.ts
      )
    ).toBe(false);
    expect(
      verifyLiveShareRevalidateSignature(
        { ...basePayload, mode: 'transition' },
        sig,
        basePayload.ts
      )
    ).toBe(false);
    expect(
      verifyLiveShareRevalidateSignature(
        { ...basePayload, ts: basePayload.ts + 1 },
        sig,
        basePayload.ts
      )
    ).toBe(false);
  });

  it('时间窗外的 ts 被拒绝（限制签名重放期）', () => {
    const sig = signLiveShareRevalidatePayload(basePayload);
    const outsideWindow = basePayload.ts + LIVE_SHARE_INTERNAL_MAX_SKEW_MS + 1;

    expect(
      verifyLiveShareRevalidateSignature(basePayload, sig, outsideWindow)
    ).toBe(false);
    // 窗内则通过
    expect(
      verifyLiveShareRevalidateSignature(
        basePayload,
        sig,
        basePayload.ts + LIVE_SHARE_INTERNAL_MAX_SKEW_MS - 1
      )
    ).toBe(true);
  });

  it('非法签名格式被拒绝（非 hex / 长度不符 / 非字符串）', () => {
    expect(
      verifyLiveShareRevalidateSignature(basePayload, 'not-hex!!', basePayload.ts)
    ).toBe(false);
    expect(
      verifyLiveShareRevalidateSignature(basePayload, 'abcd', basePayload.ts)
    ).toBe(false);
    expect(
      verifyLiveShareRevalidateSignature(
        basePayload,
        undefined as unknown as string,
        basePayload.ts
      )
    ).toBe(false);
  });

  it('超长 sessionId 或非法 mode 被拒绝', () => {
    const longPayload = { ...basePayload, sessionId: 'x'.repeat(201) };
    expect(
      verifyLiveShareRevalidateSignature(
        longPayload,
        signLiveShareRevalidatePayload(longPayload),
        basePayload.ts
      )
    ).toBe(false);

    const badMode = {
      ...basePayload,
      mode: 'evict-everyone' as unknown as 'revoke',
    };
    expect(
      verifyLiveShareRevalidateSignature(
        badMode,
        signLiveShareRevalidatePayload(badMode),
        basePayload.ts
      )
    ).toBe(false);
  });
});
