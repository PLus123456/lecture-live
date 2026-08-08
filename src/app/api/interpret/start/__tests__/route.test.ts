import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P6-7：/api/interpret/start 原先整个目录零 enforceRateLimit —— 每次调用写一行 Redis 锚点 +
 * 一行 InterpretSession，也是 start→mint→deduct 白嫖循环的入口。这里锁死「鉴权 → 按用户限流 →
 * 配额 → 建锚点」的顺序：限流必须在建任何东西之前，且必须在鉴权之后（否则分不出桶）。
 */

const {
  verifyAuthMock,
  enforceRateLimitMock,
  checkQuotaMock,
  createAnchorMock,
  createSessionMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  checkQuotaMock: vi.fn(),
  createAnchorMock: vi.fn(),
  createSessionMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/quota', () => ({ checkQuota: checkQuotaMock }));
vi.mock('@/lib/interpret/anchor', () => ({
  createInterpretAnchor: createAnchorMock,
}));
vi.mock('@/lib/interpret/session', () => ({
  createInterpretSession: createSessionMock,
}));

import { POST } from '@/app/api/interpret/start/route';

function req(): Request {
  return new Request('http://localhost/api/interpret/start', { method: 'POST' });
}

beforeEach(() => {
  verifyAuthMock.mockReset().mockResolvedValue({ id: 'user-1' });
  enforceRateLimitMock.mockReset().mockResolvedValue(null);
  checkQuotaMock.mockReset().mockResolvedValue(true);
  createAnchorMock.mockReset().mockResolvedValue('anchor-1');
  createSessionMock.mockReset().mockResolvedValue(undefined);
});

describe('POST interpret/start — P6-7 按用户限流', () => {
  it('限流命中 → 透传 429，不校配额、不建锚点、不落 InterpretSession 行', async () => {
    enforceRateLimitMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 })
    );

    const res = await POST(req());

    expect(res.status).toBe(429);
    expect(checkQuotaMock).not.toHaveBeenCalled();
    expect(createAnchorMock).not.toHaveBeenCalled();
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it('限流按 user 分桶（scope + key）', async () => {
    await POST(req());

    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: 'interpret:start:user',
        key: 'user:user-1',
      })
    );
  });

  it('未鉴权 → 401 且不进限流（先鉴权后按 user 分桶）', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);

    const res = await POST(req());

    expect(res.status).toBe(401);
    expect(enforceRateLimitMock).not.toHaveBeenCalled();
  });

  it('放行 → 正常返回 anchorId 并落锚点行', async () => {
    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ anchorId: 'anchor-1' });
    expect(createSessionMock).toHaveBeenCalledWith('user-1', 'anchor-1');
  });
});
