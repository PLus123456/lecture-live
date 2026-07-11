import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R1-C：temporary-key 在成功签发 key 后，为「同传（interpret）」流保证有一条活的未结算
 * InterpretSession 锚点（堵 skip /start 白嫖 → cron 可兜底扣费）。realtime 流不走此路。
 */

const {
  verifyAuthMock,
  checkQuotaMock,
  enforceRateLimitMock,
  ensureActiveInterpretMock,
  resolveConfigMock,
  resolveRegionMock,
  parseRegionMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  checkQuotaMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  ensureActiveInterpretMock: vi.fn(),
  resolveConfigMock: vi.fn(),
  resolveRegionMock: vi.fn(),
  parseRegionMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/quota', () => ({ checkQuota: checkQuotaMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/interpret/session', () => ({
  ensureActiveInterpretSession: ensureActiveInterpretMock,
}));
vi.mock('@/lib/soniox/env', () => ({
  parseSonioxRegionPreference: parseRegionMock,
  resolveRequestedRegionAsync: resolveRegionMock,
  resolveSonioxRuntimeConfigAsync: resolveConfigMock,
}));

import { POST } from '@/app/api/soniox/temporary-key/route';

function req(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/soniox/temporary-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  verifyAuthMock.mockReset().mockResolvedValue({ id: 'user-1', role: 'FREE' });
  checkQuotaMock.mockReset().mockResolvedValue(true);
  enforceRateLimitMock.mockReset().mockResolvedValue(null);
  ensureActiveInterpretMock.mockReset().mockResolvedValue({ id: 'is-1', created: false });
  parseRegionMock.mockReset().mockReturnValue('eu');
  resolveRegionMock.mockReset().mockResolvedValue('eu');
  resolveConfigMock.mockReset().mockResolvedValue({
    apiKey: 'k',
    restBaseUrl: 'https://api.eu.soniox.com',
    wsBaseUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket',
    region: 'eu',
  });
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ api_key: 'temp:abc', expires_at: '2099-01-01T00:00:00Z' }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

describe('POST temporary-key — R1-C interpret 锚点保证', () => {
  it('interpret 流（clientReferenceId=interpret:*）签发成功后 → ensureActiveInterpretSession(userId)', async () => {
    const res = await POST(req({ clientReferenceId: 'interpret:en:zh' }));

    expect(res.status).toBe(200);
    expect(ensureActiveInterpretMock).toHaveBeenCalledTimes(1);
    expect(ensureActiveInterpretMock).toHaveBeenCalledWith('user-1');
  });

  it('realtime 流（clientReferenceId=sessionId）→ 不建 interpret 锚点', async () => {
    const res = await POST(req({ clientReferenceId: 'cksession123abc' }));

    expect(res.status).toBe(200);
    expect(ensureActiveInterpretMock).not.toHaveBeenCalled();
  });

  it('无 clientReferenceId → 不建锚点', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(200);
    expect(ensureActiveInterpretMock).not.toHaveBeenCalled();
  });

  it('额度耗尽 → 403，不签发、不建锚点', async () => {
    checkQuotaMock.mockResolvedValueOnce(false);

    const res = await POST(req({ clientReferenceId: 'interpret:en:zh' }));

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ensureActiveInterpretMock).not.toHaveBeenCalled();
  });

  it('未授权 → 401，不建锚点', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);

    const res = await POST(req({ clientReferenceId: 'interpret:en:zh' }));

    expect(res.status).toBe(401);
    expect(ensureActiveInterpretMock).not.toHaveBeenCalled();
  });

  it('限流命中 → 返回限流响应，不建锚点', async () => {
    enforceRateLimitMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 })
    );

    const res = await POST(req({ clientReferenceId: 'interpret:en:zh' }));

    expect(res.status).toBe(429);
    expect(ensureActiveInterpretMock).not.toHaveBeenCalled();
  });

  it('Soniox 签发失败(!ok) → 不建锚点（避免为没串流的失败尝试误兜底）', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => 'upstream error',
    });

    const res = await POST(req({ clientReferenceId: 'interpret:en:zh' }));

    expect(res.status).toBe(502);
    expect(ensureActiveInterpretMock).not.toHaveBeenCalled();
  });
});
