import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R1-L1/L2：temporary-key = mint 即计费闸门。
 * 核心不变量：
 *  - 双层限流（IP 粗限 → 鉴权 → user 细限）；
 *  - 流必须声明归属（realtime 锚定本人活跃 Session；interpret 关联锚点），无归属 400；
 *  - 并发活跃 grant 超上限 429；
 *  - 签发前原子预扣（收缩式），额度耗尽 403 不签发；
 *  - 下发 max_session_duration_seconds=预扣分钟 + single_use + 服务端构造 client_reference_id；
 *  - Soniox 失败回滚预扣（rollbackStreamGrant）并作废本次补建的空锚点。
 */

const {
  verifyAuthMock,
  enforceRateLimitMock,
  ensureActiveInterpretMock,
  settleAnchorVoidMock,
  resolveConfigMock,
  resolveRegionMock,
  parseRegionMock,
  resolveMaxConcurrentMock,
  countActiveGrantsMock,
  createGrantMock,
  rollbackGrantMock,
  sessionFindFirstMock,
  interpretFindFirstMock,
  userFindUniqueMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  ensureActiveInterpretMock: vi.fn(),
  settleAnchorVoidMock: vi.fn(),
  resolveConfigMock: vi.fn(),
  resolveRegionMock: vi.fn(),
  parseRegionMock: vi.fn(),
  resolveMaxConcurrentMock: vi.fn(),
  countActiveGrantsMock: vi.fn(),
  createGrantMock: vi.fn(),
  rollbackGrantMock: vi.fn(),
  sessionFindFirstMock: vi.fn(),
  interpretFindFirstMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/interpret/session', () => ({
  ensureActiveInterpretSession: ensureActiveInterpretMock,
  settleInterpretSessionAsVoid: settleAnchorVoidMock,
}));
vi.mock('@/lib/userRoles', () => ({
  resolveUserMaxConcurrentSessions: resolveMaxConcurrentMock,
}));
vi.mock('@/lib/soniox/streamGrant', () => ({
  countActiveStreamGrants: countActiveGrantsMock,
  createStreamGrantWithReservation: createGrantMock,
  rollbackStreamGrant: rollbackGrantMock,
}));
vi.mock('@/lib/soniox/env', () => ({
  parseSonioxRegionPreference: parseRegionMock,
  resolveRequestedRegionAsync: resolveRegionMock,
  resolveSonioxRuntimeConfigAsync: resolveConfigMock,
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { findFirst: sessionFindFirstMock },
    interpretSession: { findFirst: interpretFindFirstMock },
    user: { findUnique: userFindUniqueMock },
  },
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
  enforceRateLimitMock.mockReset().mockResolvedValue(null);
  ensureActiveInterpretMock
    .mockReset()
    .mockResolvedValue({ id: 'is-1', created: false });
  settleAnchorVoidMock.mockReset().mockResolvedValue(undefined);
  parseRegionMock.mockReset().mockReturnValue('eu');
  resolveRegionMock.mockReset().mockResolvedValue('eu');
  resolveMaxConcurrentMock.mockReset().mockResolvedValue(1); // FREE：1 并发会话 → grant 上限 3
  countActiveGrantsMock.mockReset().mockResolvedValue(0);
  createGrantMock.mockReset().mockResolvedValue({
    ok: true,
    grantId: 'grant-1',
    reservedMinutes: 15,
    maxSessionSeconds: 900,
  });
  rollbackGrantMock.mockReset().mockResolvedValue(undefined);
  sessionFindFirstMock
    .mockReset()
    .mockResolvedValue({ id: 'sess-1', status: 'RECORDING' });
  interpretFindFirstMock.mockReset().mockResolvedValue(null);
  userFindUniqueMock.mockReset().mockResolvedValue({ customGroupId: null });
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

describe('POST temporary-key — 门禁链', () => {
  it('未授权 → 401，不预扣不签发', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);
    const res = await POST(req({ kind: 'realtime', sessionId: 'sess-1' }));
    expect(res.status).toBe(401);
    expect(createGrantMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('IP 粗限流命中（鉴权前）→ 透传限流响应', async () => {
    enforceRateLimitMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 })
    );
    const res = await POST(req({ kind: 'realtime', sessionId: 'sess-1' }));
    expect(res.status).toBe(429);
    expect(verifyAuthMock).not.toHaveBeenCalled();
  });

  it('user 细限流命中（鉴权后第二道）→ 429；两道限流的 scope/key 正确', async () => {
    enforceRateLimitMock
      .mockResolvedValueOnce(null) // IP 层放行
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 })
      );
    const res = await POST(req({ kind: 'realtime', sessionId: 'sess-1' }));
    expect(res.status).toBe(429);
    expect(enforceRateLimitMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ scope: 'soniox:temporary-key' })
    );
    expect(enforceRateLimitMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        scope: 'soniox:temporary-key:user',
        key: 'user:user-1',
      })
    );
    expect(createGrantMock).not.toHaveBeenCalled();
  });

  it('无 kind 且无 legacy clientReferenceId → 400（不再签发无归属的 key）', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(createGrantMock).not.toHaveBeenCalled();
  });

  it('realtime 缺 sessionId → 400', async () => {
    const res = await POST(req({ kind: 'realtime' }));
    expect(res.status).toBe(400);
  });

  it('realtime session 不存在/不属于本人 → 404', async () => {
    sessionFindFirstMock.mockResolvedValueOnce(null);
    const res = await POST(req({ kind: 'realtime', sessionId: 'sess-x' }));
    expect(res.status).toBe(404);
    expect(sessionFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sess-x', userId: 'user-1' },
      })
    );
    expect(createGrantMock).not.toHaveBeenCalled();
  });

  it('realtime session 已终态（COMPLETED）→ 409', async () => {
    sessionFindFirstMock.mockResolvedValueOnce({ id: 'sess-1', status: 'COMPLETED' });
    const res = await POST(req({ kind: 'realtime', sessionId: 'sess-1' }));
    expect(res.status).toBe(409);
  });

  it('并发活跃 grant 达上限（maxConcurrent*2+1）→ 429', async () => {
    countActiveGrantsMock.mockResolvedValueOnce(3); // FREE: 1*2+1=3
    const res = await POST(req({ kind: 'realtime', sessionId: 'sess-1' }));
    expect(res.status).toBe(429);
    expect(createGrantMock).not.toHaveBeenCalled();
  });

  it('额度耗尽（quota_exhausted）→ 403，不签发；interpret 场景作废本次补建的空锚点', async () => {
    ensureActiveInterpretMock.mockResolvedValueOnce({ id: 'is-new', created: true });
    createGrantMock.mockResolvedValueOnce({ ok: false, reason: 'quota_exhausted' });
    const res = await POST(req({ kind: 'interpret' }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(settleAnchorVoidMock).toHaveBeenCalledWith('is-new', 'mint_failed');
  });
});

describe('POST temporary-key — 成功路径的 Soniox 参数（L1 三件套）', () => {
  it('realtime：预扣量决定 max_session_duration_seconds；single_use；服务端构造 ref', async () => {
    const res = await POST(req({ kind: 'realtime', sessionId: 'sess-1' }));
    expect(res.status).toBe(200);

    expect(createGrantMock).toHaveBeenCalledWith({
      userId: 'user-1',
      kind: 'realtime',
      sessionId: 'sess-1',
      interpretSessionId: null,
      region: 'eu',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      usage_type: 'transcribe_websocket',
      expires_in_seconds: 60,
      max_session_duration_seconds: 900,
      single_use: true,
      client_reference_id: 'rt:user-1:grant-1',
    });

    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.max_session_duration_seconds).toBe(900);
    expect(payload.api_key).toBe('temp:abc');
  });

  it('收缩预扣：只剩 3 分钟 → key 上限收缩到 180s', async () => {
    createGrantMock.mockResolvedValueOnce({
      ok: true,
      grantId: 'grant-2',
      reservedMinutes: 3,
      maxSessionSeconds: 180,
    });
    const res = await POST(req({ kind: 'realtime', sessionId: 'sess-1' }));
    expect(res.status).toBe(200);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.max_session_duration_seconds).toBe(180);
  });

  it('interpret（新协议）：ensure 锚点并关联 grant；ref 前缀 it:', async () => {
    ensureActiveInterpretMock.mockResolvedValueOnce({ id: 'is-7', created: true });
    const res = await POST(req({ kind: 'interpret' }));
    expect(res.status).toBe(200);
    expect(ensureActiveInterpretMock).toHaveBeenCalledWith('user-1');
    expect(createGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'interpret', interpretSessionId: 'is-7' })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.client_reference_id).toBe('it:user-1:grant-1');
  });

  it('interpret + anchorId：命中本人未结锚点 → 精确关联、不走 ensure 启发式', async () => {
    interpretFindFirstMock.mockResolvedValueOnce({ id: 'is-exact' });
    const res = await POST(req({ kind: 'interpret', anchorId: 'anchor-9' }));
    expect(res.status).toBe(200);
    expect(interpretFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { anchorId: 'anchor-9', userId: 'user-1', settledAt: null },
      })
    );
    expect(ensureActiveInterpretMock).not.toHaveBeenCalled();
    expect(createGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({ interpretSessionId: 'is-exact' })
    );
  });

  it('legacy body 兼容：clientReferenceId=interpret:* → interpret 流', async () => {
    const res = await POST(req({ clientReferenceId: 'interpret:en:zh' }));
    expect(res.status).toBe(200);
    expect(ensureActiveInterpretMock).toHaveBeenCalledWith('user-1');
    expect(createGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'interpret' })
    );
  });

  it('legacy body 兼容：clientReferenceId=sessionId → realtime 流（含归属校验）', async () => {
    const res = await POST(req({ clientReferenceId: 'sess-1' }));
    expect(res.status).toBe(200);
    expect(sessionFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sess-1', userId: 'user-1' } })
    );
    expect(createGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'realtime', sessionId: 'sess-1' })
    );
  });
});

describe('POST temporary-key — 失败回滚', () => {
  it('Soniox 签发失败(!ok) → 回滚预扣 + 作废本次补建空锚点 + 透传状态码', async () => {
    ensureActiveInterpretMock.mockResolvedValueOnce({ id: 'is-new', created: true });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => 'upstream error',
    });
    const res = await POST(req({ kind: 'interpret' }));
    expect(res.status).toBe(502);
    expect(rollbackGrantMock).toHaveBeenCalledWith('grant-1');
    expect(settleAnchorVoidMock).toHaveBeenCalledWith('is-new', 'mint_failed');
  });

  it('Soniox 签发失败但锚点是复用的（created=false）→ 只回滚预扣，不动别人的锚点', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => 'upstream error',
    });
    const res = await POST(req({ kind: 'interpret' }));
    expect(res.status).toBe(502);
    expect(rollbackGrantMock).toHaveBeenCalledWith('grant-1');
    expect(settleAnchorVoidMock).not.toHaveBeenCalled();
  });

  it('fetch 抛异常（网络）→ 500 + 回滚预扣', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const res = await POST(req({ kind: 'realtime', sessionId: 'sess-1' }));
    expect(res.status).toBe(500);
    expect(rollbackGrantMock).toHaveBeenCalledWith('grant-1');
  });
});
