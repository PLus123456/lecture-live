import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  auditLogDeleteManyMock,
  auditLogCountMock,
  auditLogFindManyMock,
  transactionMock,
  logActionMock,
  writeSecurityAuditMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  auditLogDeleteManyMock: vi.fn(),
  auditLogCountMock: vi.fn(),
  auditLogFindManyMock: vi.fn(),
  transactionMock: vi.fn(),
  logActionMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/auditLog', () => ({
  logAction: logActionMock,
}));

vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    auditLog: {
      deleteMany: auditLogDeleteManyMock,
      count: auditLogCountMock,
      findMany: auditLogFindManyMock,
    },
    $transaction: transactionMock,
  },
}));

import { DELETE, GET } from '@/app/api/admin/logs/route';

const adminUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'ADMIN' as const,
  displayName: 'Admin',
};

beforeEach(() => {
  requireAdminAccessMock.mockReset();
  auditLogDeleteManyMock.mockReset();
  auditLogCountMock.mockReset();
  auditLogFindManyMock.mockReset();
  transactionMock.mockReset();
  logActionMock.mockReset();
  writeSecurityAuditMock.mockReset();
  requireAdminAccessMock.mockResolvedValue({ user: adminUser, response: null });
  writeSecurityAuditMock.mockResolvedValue({
    requestId: 'request-1',
    action: 'admin.security.audit_logs.cleanup',
  });
  transactionMock.mockImplementation(async (callback) =>
    callback({ auditLog: { deleteMany: auditLogDeleteManyMock } })
  );
});

function deleteReq(params: Record<string, string | string[]>): Request {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) sp.append(k, item);
    } else {
      sp.set(k, v);
    }
  }
  return new Request(`http://localhost:3000/api/admin/logs?${sp.toString()}`, {
    method: 'DELETE',
  });
}

describe('DELETE /api/admin/logs', () => {
  it('合法类别 — 调用 deleteMany，action 用 in 数组（精确白名单）', async () => {
    auditLogDeleteManyMock.mockResolvedValue({ count: 7 });

    const res = await DELETE(
      deleteReq({ actionCategories: ['session', 'login'], olderThanDays: '90' })
    );
    expect(res.status).toBe(200);
    await expect(readJson<{ deletedCount: number }>(res)).resolves.toMatchObject({
      success: true,
      deletedCount: 7,
    });

    const call = auditLogDeleteManyMock.mock.calls[0]?.[0];
    const allowed: string[] = call.where.action.in;
    // 永不删的 action 不应在 in 数组里
    for (const a of allowed) {
      expect(a.startsWith('admin.')).toBe(false);
      expect(a).not.toBe('user.register');
      expect(a).not.toBe('user.password.change');
      expect(a).not.toBe('user.login.failed');
    }
    expect(allowed).toEqual(
      expect.arrayContaining(['session.create', 'session.finalize', 'user.login', 'user.logout'])
    );
    expect(call.where.createdAt.lt).toBeInstanceOf(Date);
  });

  it('空类别返回 400 — deleteMany 不被调用', async () => {
    const res = await DELETE(deleteReq({ olderThanDays: '60' }));
    expect(res.status).toBe(400);
    expect(auditLogDeleteManyMock).not.toHaveBeenCalled();
  });

  it.each(['admin', 'register', 'password', 'all', ''])(
    '拒绝危险类别 %s — deleteMany 不被调用',
    async (cat) => {
      const res = await DELETE(
        deleteReq({ actionCategories: cat, olderThanDays: '60' })
      );
      expect(res.status).toBe(400);
      expect(auditLogDeleteManyMock).not.toHaveBeenCalled();
    }
  );

  it('olderThanDays < 30 返回 400', async () => {
    const res = await DELETE(
      deleteReq({ actionCategories: 'session', olderThanDays: '7' })
    );
    expect(res.status).toBe(400);
    expect(auditLogDeleteManyMock).not.toHaveBeenCalled();
  });

  it('olderThanDays > 730 返回 400', async () => {
    const res = await DELETE(
      deleteReq({ actionCategories: 'session', olderThanDays: '1000' })
    );
    expect(res.status).toBe(400);
    expect(auditLogDeleteManyMock).not.toHaveBeenCalled();
  });

  it('记录 admin.auditlog.cleanup 审计日志', async () => {
    auditLogDeleteManyMock.mockResolvedValue({ count: 5 });

    await DELETE(deleteReq({ actionCategories: 'system', olderThanDays: '180' }));
    expect(logActionMock).toHaveBeenCalledWith(
      expect.anything(),
      'admin.auditlog.cleanup',
      expect.objectContaining({ user: adminUser })
    );
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'audit_logs.cleanup',
        outcome: 'SUCCESS',
      }),
      expect.objectContaining({ auditLog: expect.any(Object) })
    );
  });

  it('安全审计写入失败时返回 503，且不记录删除成功', async () => {
    auditLogDeleteManyMock.mockResolvedValue({ count: 5 });
    writeSecurityAuditMock.mockRejectedValue(new Error('audit unavailable'));

    const res = await DELETE(
      deleteReq({ actionCategories: 'system', olderThanDays: '180' })
    );

    expect(res.status).toBe(503);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(logActionMock).not.toHaveBeenCalled();
    await expect(readJson<{ error: string }>(res)).resolves.toEqual({
      error: '安全审计服务不可用',
    });
  });

  it('非管理员 — deleteMany 不被调用', async () => {
    requireAdminAccessMock.mockResolvedValue({
      user: null,
      response: new Response('forbidden', { status: 403 }),
    });

    const res = await DELETE(
      deleteReq({ actionCategories: 'session', olderThanDays: '90' })
    );
    expect(res.status).toBe(403);
    expect(auditLogDeleteManyMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/logs?cleanup_preview=1', () => {
  it('返回 count 而不删', async () => {
    auditLogCountMock.mockResolvedValue(50);

    const req = new Request(
      'http://localhost:3000/api/admin/logs?cleanup_preview=1&actionCategories=session&olderThanDays=60'
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    await expect(readJson<{ count: number }>(res)).resolves.toEqual({ count: 50 });
    expect(auditLogDeleteManyMock).not.toHaveBeenCalled();
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        event: 'audit_logs.cleanup_preview',
        after: { eligibleCount: 50 },
      })
    );
  });

  it('审计失败时不返回清理预览数据', async () => {
    auditLogCountMock.mockResolvedValue(50);
    writeSecurityAuditMock.mockRejectedValue(new Error('audit unavailable'));

    const req = new Request(
      'http://localhost:3000/api/admin/logs?cleanup_preview=1&actionCategories=session&olderThanDays=60'
    );
    const res = await GET(req);

    expect(res.status).toBe(503);
    await expect(readJson<Record<string, unknown>>(res)).resolves.toEqual({
      error: '安全审计服务不可用',
    });
  });

  it('preview 也拒绝危险类别', async () => {
    const req = new Request(
      'http://localhost:3000/api/admin/logs?cleanup_preview=1&actionCategories=admin&olderThanDays=60'
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(auditLogCountMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/logs', () => {
  it('返回敏感日志前等待安全审计成功', async () => {
    auditLogFindManyMock.mockResolvedValue([
      { id: 'log-1', detail: 'sensitive evidence' },
    ]);
    auditLogCountMock.mockResolvedValue(1);

    const req = new Request('http://localhost:3000/api/admin/logs?page=1');
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        event: 'audit_logs.read',
        outcome: 'SUCCESS',
        after: expect.objectContaining({ resultCount: 1, total: 1 }),
      })
    );
  });

  it('安全审计失败时不泄露日志内容', async () => {
    auditLogFindManyMock.mockResolvedValue([
      { id: 'log-1', detail: 'sensitive evidence' },
    ]);
    auditLogCountMock.mockResolvedValue(1);
    writeSecurityAuditMock.mockRejectedValue(new Error('audit unavailable'));

    const res = await GET(
      new Request('http://localhost:3000/api/admin/logs?page=1')
    );
    const body = await readJson<Record<string, unknown>>(res);

    expect(res.status).toBe(503);
    expect(body).toEqual({ error: '安全审计服务不可用' });
    expect(JSON.stringify(body)).not.toContain('sensitive evidence');
  });
});
