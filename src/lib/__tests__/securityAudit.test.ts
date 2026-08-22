import { beforeEach, describe, expect, it, vi } from 'vitest';

const { auditCreateMock, resolveRequestClientIpMock } = vi.hoisted(() => ({
  auditCreateMock: vi.fn(),
  resolveRequestClientIpMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { auditLog: { create: auditCreateMock } },
}));

vi.mock('@/lib/clientIp', () => ({
  resolveRequestClientIp: resolveRequestClientIpMock,
}));

import {
  getSecurityAuditRequestId,
  type SecurityAuditEvent,
  writeSecurityAudit,
} from '@/lib/securityAudit';

function request(headers?: Record<string, string>): Request {
  return new Request('https://lecture.test/api/admin/users?secret=not-logged', {
    method: 'PATCH',
    headers,
  });
}

function event(overrides: Partial<SecurityAuditEvent> = {}): SecurityAuditEvent {
  return {
    event: 'users.update',
    operator: {
      id: 'admin-1',
      email: 'admin@example.test',
      displayName: 'Security Admin',
      role: 'ADMIN',
    },
    target: { type: 'user', id: 'user-1', ownerId: 'user-1' },
    before: { role: 'USER' },
    after: { role: 'ADMIN' },
    reason: 'approved-role-change',
    outcome: 'SUCCESS',
    metadata: { ticket: 'SEC-33' },
    ...overrides,
  };
}

function createdData(mock = auditCreateMock): Record<string, unknown> {
  return mock.mock.calls[0][0].data as Record<string, unknown>;
}

beforeEach(() => {
  auditCreateMock.mockReset().mockResolvedValue({ id: 'audit-1' });
  resolveRequestClientIpMock.mockReset().mockReturnValue('198.51.100.7');
});

describe('writeSecurityAudit', () => {
  it('awaits persistence instead of resolving fire-and-forget', async () => {
    let release!: (value: { id: string }) => void;
    auditCreateMock.mockReturnValueOnce(
      new Promise<{ id: string }>((resolve) => {
        release = resolve;
      })
    );

    let settled = false;
    const pending = writeSecurityAudit(request(), event()).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(auditCreateMock).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    release({ id: 'audit-1' });
    await pending;
    expect(settled).toBe(true);
  });

  it('propagates persistence failures to the caller', async () => {
    const failure = new Error('audit database unavailable');
    auditCreateMock.mockRejectedValueOnce(failure);

    await expect(writeSecurityAudit(request(), event())).rejects.toBe(failure);
  });

  it('uses an injected transaction delegate and never falls back to global prisma', async () => {
    const txCreate = vi.fn().mockResolvedValue({ id: 'audit-tx' });
    const result = await writeSecurityAudit(request(), event(), {
      auditLog: { create: txCreate },
    } as never);

    expect(result.action).toBe('admin.security.users.update');
    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(auditCreateMock).not.toHaveBeenCalled();
  });

  it('forces the admin.security namespace and rejects non-canonical event slugs', async () => {
    await expect(
      writeSecurityAudit(request(), event({ event: '../user.delete' }))
    ).rejects.toThrow(TypeError);
    await expect(
      writeSecurityAudit(request(), event({ event: 'Admin.Security.Delete' }))
    ).rejects.toThrow(TypeError);
    await expect(
      writeSecurityAudit(request(), event({ event: 'users..delete' }))
    ).rejects.toThrow(TypeError);
    expect(auditCreateMock).not.toHaveBeenCalled();

    await writeSecurityAudit(request(), event({ event: 'share_links.read' }));
    expect(createdData().action).toBe('admin.security.share_links.read');
  });

  it('writes structured legacy-compatible data and recursively redacts sensitive keys', async () => {
    const happenedAt = new Date('2026-08-20T12:34:56.000Z');
    const req = request({ 'x-request-id': 'edge-request_123' });
    const serverRequestId = getSecurityAuditRequestId(req);
    await writeSecurityAudit(
      req,
      event({
        target: {
          type: 'user',
          id: 'user-1',
          password: 'pw',
          passwordChanged: true,
          stripeSecretKey: { changed: true },
          nested: {
            accessToken: 'token-value',
            api_key: 'api-value',
            Authorization: 'Bearer value',
            cookie: 'session=value',
            clientCredential: 'credential-value',
            privateKey: 'private-value',
            oauthCode: 'code-value',
            pkceVerifier: 'verifier-value',
          },
        },
        before: { amount: BigInt('9007199254740993'), happenedAt },
        after: undefined,
        metadata: undefined,
      })
    );

    const data = createdData();
    expect(data).toMatchObject({
      action: 'admin.security.users.update',
      userId: 'admin-1',
      userName: 'Security Admin',
      ip: '198.51.100.7',
    });
    const detail = JSON.parse(data.detail as string);
    expect(detail).toMatchObject({
      version: 1,
      requestId: serverRequestId,
      operator: {
        id: 'admin-1',
        email: 'admin@example.test',
        displayName: 'Security Admin',
        role: 'ADMIN',
      },
      reason: 'approved-role-change',
      outcome: 'SUCCESS',
      method: 'PATCH',
      path: '/api/admin/users',
      before: {
        amount: '9007199254740993',
        happenedAt: '2026-08-20T12:34:56.000Z',
      },
      after: null,
      metadata: null,
    });
    expect(detail.target.password).toBe('[REDACTED]');
    expect(detail.target.passwordChanged).toBe(true);
    expect(detail.target.stripeSecretKey).toEqual({ changed: true });
    expect(Object.values(detail.target.nested)).toEqual(
      Array(8).fill('[REDACTED]')
    );
    expect(data.detail).not.toContain('not-logged');
    expect(data.detail).not.toContain('token-value');
  });

  it('preserves boolean-only secret change markers without preserving secret values', async () => {
    await writeSecurityAudit(
      request(),
      event({
        after: {
          passwordChanged: true,
          stripeSecretKey: { changed: true, configured: true },
          apiKey: { changed: true, value: 'must-not-survive' },
        },
      })
    );

    const detail = JSON.parse(createdData().detail as string);
    expect(detail.after.passwordChanged).toBe(true);
    expect(detail.after.stripeSecretKey).toEqual({
      changed: true,
      configured: true,
    });
    expect(detail.after.apiKey).toBe('[REDACTED]');
    expect(createdData().detail).not.toContain('must-not-survive');
  });

  it('bounds depth, arrays, keys, strings, and final UTF-8 detail size', async () => {
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`field${index}`, 'x'.repeat(10_000)])
    );
    const deep = { value: 'root' } as { value: string; child?: unknown };
    let cursor = deep;
    for (let index = 0; index < 10; index += 1) {
      const child = { value: `depth-${index}` };
      cursor.child = child;
      cursor = child;
    }

    await writeSecurityAudit(
      request(),
      event({
        target: {
          type: 'user_collection',
          ids: Array.from({ length: 50 }, () => '🔐'.repeat(10_000)),
        },
        before: deep,
        after: Array.from({ length: 100 }, (_, index) => index),
        metadata: tooManyKeys,
      })
    );

    const serialized = createdData().detail as string;
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(32_768);
    expect(serialized).toContain('TRUNCATED');
  });

  it('uses a minimal bounded fallback for multibyte target identifiers', async () => {
    await writeSecurityAudit(
      request(),
      event({
        target: {
          type: 'share_link',
          ids: Array.from({ length: 50 }, () => '🔐'.repeat(2_048)),
        },
      })
    );

    const serialized = createdData().detail as string;
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(32_768);
    expect(serialized).toContain('audit detail size limit exceeded');
  });

  it('stores unknown client identity as null', async () => {
    resolveRequestClientIpMock.mockReturnValueOnce('unknown');
    await writeSecurityAudit(request(), event());
    expect(createdData().ip).toBeNull();
  });
});

describe('getSecurityAuditRequestId', () => {
  it('ignores a client-chosen inbound ID and remains stable for the same Request', () => {
    const req = request({ 'x-request-id': 'gateway:request-123_abc' });
    const first = getSecurityAuditRequestId(req);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(first).not.toBe('gateway:request-123_abc');
    expect(getSecurityAuditRequestId(req)).toBe(first);
  });

  it('replaces malformed or overlong inbound IDs with a stable server UUID', () => {
    for (const inbound of ['bad id', '../escape', 'x'.repeat(129)]) {
      const req = request({ 'x-request-id': inbound });
      const first = getSecurityAuditRequestId(req);
      expect(first).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(getSecurityAuditRequestId(req)).toBe(first);
      expect(first).not.toBe(inbound);
    }
  });

  it('accepts only an explicit requestId matching the Request correlation ID', async () => {
    const req = request({ 'x-request-id': 'request-1' });
    const requestId = getSecurityAuditRequestId(req);
    await expect(
      writeSecurityAudit(req, event({ requestId }))
    ).resolves.toMatchObject({ requestId });
    await expect(
      writeSecurityAudit(req, event({ requestId: 'client-forged-id' }))
    ).rejects.toThrow('does not match');
  });
});
