import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enforceRateLimitMock, resolveRequestClientIpMock } = vi.hoisted(() => ({
  enforceRateLimitMock: vi.fn(),
  resolveRequestClientIpMock: vi.fn(),
}));

vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/clientIp', () => ({
  resolveRequestClientIp: resolveRequestClientIpMock,
}));

import {
  PUBLIC_AUTH_BODY_MAX_BYTES,
  enforcePublicAuthPrelude,
  guardAuthMutationRequest,
  publicAuthAccountKey,
  readPublicAuthJson,
} from '@/lib/publicAuth';

describe('SEC-007 public auth admission', () => {
  beforeEach(() => {
    enforceRateLimitMock.mockReset().mockResolvedValue(null);
    resolveRequestClientIpMock.mockReset().mockReturnValue('203.0.113.9');
  });

  it('stops at the fixed global gate before resolving an IP', async () => {
    const blocked = new Response('limited', { status: 429 });
    enforceRateLimitMock.mockResolvedValueOnce(blocked);

    const result = await enforcePublicAuthPrelude(new Request('http://local'), {
      scope: 'login',
      endpointIpLimit: 50,
      endpointWindowMs: 60_000,
    });

    expect(result.response).toBe(blocked);
    expect(enforceRateLimitMock).toHaveBeenCalledTimes(1);
    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ scope: 'auth:public:global', key: 'global' })
    );
    expect(resolveRequestClientIpMock).not.toHaveBeenCalled();
  });

  it('keeps the global gate when IP is unknown and uses bounded fixed keys otherwise', async () => {
    resolveRequestClientIpMock.mockReturnValueOnce('unknown');
    await enforcePublicAuthPrelude(new Request('http://local'), {
      scope: 'login',
      endpointIpLimit: 50,
      endpointWindowMs: 60_000,
    });
    expect(enforceRateLimitMock).toHaveBeenCalledTimes(1);

    enforceRateLimitMock.mockClear();
    resolveRequestClientIpMock.mockReturnValueOnce('198.51.100.4');
    await enforcePublicAuthPrelude(new Request('http://local'), {
      scope: 'register',
      endpointIpLimit: 25,
      endpointWindowMs: 600_000,
    });
    expect(enforceRateLimitMock.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ scope: 'auth:public:global', key: 'global' }),
      expect.objectContaining({ scope: 'auth:public:ip', key: 'ip:198.51.100.4' }),
      expect.objectContaining({
        scope: 'auth:register:prelude:ip',
        key: 'ip:198.51.100.4',
      }),
    ]);
  });

  it('hashes normalized account identities into fixed-length bucket keys', () => {
    const key = publicAuthAccountKey('email', 'alice@example.com');
    expect(key).toMatch(/^email:sha256:[a-f0-9]{64}$/);
    expect(key).not.toContain('alice@example.com');
    expect(publicAuthAccountKey('email', 'alice@example.com')).toBe(key);
  });

  it('rejects an oversized Content-Length before opening the body reader', async () => {
    const getReader = vi.fn();
    const req = {
      headers: new Headers({
        'content-type': 'application/json',
        'content-length': String(PUBLIC_AUTH_BODY_MAX_BYTES + 1),
      }),
      body: { getReader },
    } as unknown as Request;

    const result = await readPublicAuthJson(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
    expect(getReader).not.toHaveBeenCalled();
  });

  it('counts actual chunked bytes and cancels once the hard cap is crossed', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    let reads = 0;
    const reader = {
      read: vi.fn(async () => {
        reads += 1;
        if (reads === 1) return { done: false, value: new Uint8Array(5000) };
        return { done: false, value: new Uint8Array(4000) };
      }),
      cancel,
      releaseLock: vi.fn(),
    };
    const req = {
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => reader },
    } as unknown as Request;

    const result = await readPublicAuthJson(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(reader.read).toHaveBeenCalledTimes(2);
  });

  it('accepts a valid small multi-byte JSON object', async () => {
    const req = new Request('http://local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '张三', email: 'a@example.com' }),
    });
    const result = await readPublicAuthJson<{
      displayName: string;
      email: string;
    }>(req);
    expect(result).toEqual({
      ok: true,
      body: { displayName: '张三', email: 'a@example.com' },
    });
  });

  it('rejects sibling/cross-site browser mutations and text/plain before parsing', async () => {
    const evilOrigin = new Request('https://app.example/api/auth/login', {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'same-site',
        'Content-Type': 'text/plain',
      },
      body: '{"email":"attacker@example.com"}',
    });
    const evilResponse = guardAuthMutationRequest(evilOrigin, {
      requireJson: true,
    });
    expect(evilResponse?.status).toBe(403);
    expect(evilResponse?.headers.get('set-cookie')).toBeNull();
    expect(evilResponse?.headers.get('clear-site-data')).toBeNull();

    const textPlain = new Request('https://app.example/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    const parsed = await readPublicAuthJson(textPlain);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.response.status).toBe(415);
  });
});
