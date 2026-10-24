import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOrCreateSessionShareUrl } from '../sessionShareLink';

/**
 * 文件夹页「分享」回归锁（审计 medium）：
 *   - 旧代码拼 `/session/<id>/view/<token>` —— 不存在的路由，复制出去一律 404；
 *   - 旧代码每次 POST 都带 expiresInHours:72，服务端复用已有回放链接时会改写其过期时间，
 *     把用户早先生成的永久链接静默缩短成 72h。
 */

const NOW = Date.parse('2026-10-24T00:00:00Z');
const ORIGIN = 'https://app.example';

type Call = { url: string; method: string; body: unknown };

function stubFetch(listBody: unknown, opts?: { listOk?: boolean; createBody?: unknown; createOk?: boolean }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === 'GET') {
        return {
          ok: opts?.listOk ?? true,
          status: opts?.listOk === false ? 500 : 200,
          json: async () => listBody,
        };
      }
      return {
        ok: opts?.createOk ?? true,
        status: opts?.createOk === false ? 403 : 201,
        json: async () => opts?.createBody ?? {},
      };
    })
  );
  return calls;
}

const baseOptions = {
  sessionId: 'sess-1',
  authHeaders: { Authorization: 'Bearer t' },
  expiresInHours: 72,
  failureMessage: 'share failed',
  origin: ORIGIN,
  nowMs: NOW,
};

describe('getOrCreateSessionShareUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('已有永久回放链接 → 原样复用其 url，绝不 POST（不改写有效期）', async () => {
    const calls = stubFetch([
      {
        token: 'tok-perm',
        isLive: false,
        expiresAt: null,
        url: `${ORIGIN}/session/sess-1/view?token=tok-perm`,
        session: { id: 'sess-1' },
      },
    ]);

    const url = await getOrCreateSessionShareUrl(baseOptions);

    expect(url).toBe(`${ORIGIN}/session/sess-1/view?token=tok-perm`);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('无可复用链接 → 新建 72h 回放链接，并使用服务端返回的 url（真实路由）', async () => {
    const calls = stubFetch(
      [
        // 别的会话 / live / 已过期的链接都不可复用
        { token: 'other', isLive: false, expiresAt: null, url: 'x', session: { id: 'sess-2' } },
        { token: 'live', isLive: true, expiresAt: null, url: 'y', session: { id: 'sess-1' } },
        { token: 'old', isLive: false, expiresAt: '2026-10-01T00:00:00Z', url: 'z', session: { id: 'sess-1' } },
      ],
      { createBody: { token: 'tok-new', url: `${ORIGIN}/session/sess-1/view?token=tok-new` } }
    );

    const url = await getOrCreateSessionShareUrl(baseOptions);

    expect(url).toBe(`${ORIGIN}/session/sess-1/view?token=tok-new`);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ sessionId: 'sess-1', isLive: false, expiresInHours: 72 });
  });

  it('服务端未返回 url 时按真实路由兜底拼（?token=），绝不拼成 /view/<token>', async () => {
    stubFetch([], { createBody: { token: 'tok/+=' } });

    const url = await getOrCreateSessionShareUrl(baseOptions);

    expect(url).toBe(`${ORIGIN}/session/sess-1/view?token=${encodeURIComponent('tok/+=')}`);
    expect(url).not.toContain('/view/');
  });

  it('列表拉取失败 → 抛错且不 POST（避免盲改已有链接的有效期）', async () => {
    const calls = stubFetch({ error: 'boom' }, { listOk: false });

    await expect(getOrCreateSessionShareUrl(baseOptions)).rejects.toThrow('boom');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('新建失败 → 抛出服务端错误文案', async () => {
    stubFetch([], { createOk: false, createBody: { error: 'Access denied' } });

    await expect(getOrCreateSessionShareUrl(baseOptions)).rejects.toThrow('Access denied');
  });
});
