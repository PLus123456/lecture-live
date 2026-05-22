import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  auditLogDeleteManyMock,
  auditLogCountMock,
  logActionMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  auditLogDeleteManyMock: vi.fn(),
  auditLogCountMock: vi.fn(),
  logActionMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/auditLog', () => ({
  logAction: logActionMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    auditLog: {
      deleteMany: auditLogDeleteManyMock,
      count: auditLogCountMock,
      findMany: vi.fn(),
    },
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
  logActionMock.mockReset();
  requireAdminAccessMock.mockResolvedValue({ user: adminUser, response: null });
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
