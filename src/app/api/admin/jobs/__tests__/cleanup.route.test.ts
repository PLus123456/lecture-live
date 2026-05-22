import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  jobQueueDeleteManyMock,
  jobQueueCountMock,
  logActionMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  jobQueueDeleteManyMock: vi.fn(),
  jobQueueCountMock: vi.fn(),
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
    jobQueue: {
      deleteMany: jobQueueDeleteManyMock,
      count: jobQueueCountMock,
    },
  },
}));

import { DELETE, GET } from '@/app/api/admin/jobs/route';

const adminUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'ADMIN' as const,
  displayName: 'Admin',
};

beforeEach(() => {
  requireAdminAccessMock.mockReset();
  jobQueueDeleteManyMock.mockReset();
  jobQueueCountMock.mockReset();
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
  return new Request(`http://localhost:3000/api/admin/jobs?${sp.toString()}`, {
    method: 'DELETE',
  });
}

describe('DELETE /api/admin/jobs', () => {
  it.each(['SUBMITTED', 'PENDING', 'PROCESSING'])(
    '拒绝 in-flight 状态 %s — 返回 400 且不调用 deleteMany',
    async (status) => {
      const res = await DELETE(deleteReq({ statuses: status, olderThanDays: '30' }));
      expect(res.status).toBe(400);
      expect(jobQueueDeleteManyMock).not.toHaveBeenCalled();
      expect(logActionMock).not.toHaveBeenCalled();
    }
  );

  it('混入 SUBMITTED 也拒绝，即使有 SUCCESS', async () => {
    const res = await DELETE(
      deleteReq({ statuses: ['SUCCESS', 'SUBMITTED'], olderThanDays: '30' })
    );
    expect(res.status).toBe(400);
    expect(jobQueueDeleteManyMock).not.toHaveBeenCalled();
  });

  it('空 statuses 返回 400', async () => {
    const res = await DELETE(deleteReq({ olderThanDays: '30' }));
    expect(res.status).toBe(400);
    expect(jobQueueDeleteManyMock).not.toHaveBeenCalled();
  });

  it('olderThanDays 超界返回 400', async () => {
    const res = await DELETE(deleteReq({ statuses: 'SUCCESS', olderThanDays: '0' }));
    expect(res.status).toBe(400);
    expect(jobQueueDeleteManyMock).not.toHaveBeenCalled();
  });

  it('未知 type 返回 400', async () => {
    const res = await DELETE(
      deleteReq({ statuses: 'SUCCESS', olderThanDays: '30', type: 'bogus_type' })
    );
    expect(res.status).toBe(400);
    expect(jobQueueDeleteManyMock).not.toHaveBeenCalled();
  });

  it('合法入参 — 调用 deleteMany、写审计日志、返回 count', async () => {
    jobQueueDeleteManyMock.mockResolvedValue({ count: 12 });

    const res = await DELETE(
      deleteReq({ statuses: ['SUCCESS', 'FAILED'], olderThanDays: '30' })
    );
    expect(res.status).toBe(200);
    await expect(readJson<{ deletedCount: number }>(res)).resolves.toMatchObject({
      success: true,
      deletedCount: 12,
    });

    expect(jobQueueDeleteManyMock).toHaveBeenCalledTimes(1);
    const call = jobQueueDeleteManyMock.mock.calls[0]?.[0];
    expect(call.where.status).toEqual({ in: ['SUCCESS', 'FAILED'] });
    expect(call.where.createdAt.lt).toBeInstanceOf(Date);
    expect(call.where).not.toHaveProperty('type');

    expect(logActionMock).toHaveBeenCalledWith(
      expect.anything(),
      'admin.job.cleanup',
      expect.objectContaining({ user: adminUser })
    );
  });

  it('指定 type 时，把 type 加入 where 子句', async () => {
    jobQueueDeleteManyMock.mockResolvedValue({ count: 3 });

    await DELETE(
      deleteReq({
        statuses: 'SUCCESS',
        olderThanDays: '7',
        type: 'report_generation',
      })
    );
    const call = jobQueueDeleteManyMock.mock.calls[0]?.[0];
    expect(call.where.type).toBe('report_generation');
  });

  it('非管理员被 requireAdminAccess 拦截 — deleteMany 不被调用', async () => {
    requireAdminAccessMock.mockResolvedValue({
      user: null,
      response: new Response('forbidden', { status: 403 }),
    });

    const res = await DELETE(deleteReq({ statuses: 'SUCCESS', olderThanDays: '30' }));
    expect(res.status).toBe(403);
    expect(jobQueueDeleteManyMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/jobs?cleanup_preview=1', () => {
  it('返回 count 而不删', async () => {
    jobQueueCountMock.mockResolvedValue(42);

    const req = new Request(
      'http://localhost:3000/api/admin/jobs?cleanup_preview=1&statuses=SUCCESS&olderThanDays=30'
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    await expect(readJson<{ count: number }>(res)).resolves.toEqual({ count: 42 });
    expect(jobQueueDeleteManyMock).not.toHaveBeenCalled();
  });

  it('preview 也拒绝 in-flight 状态', async () => {
    const req = new Request(
      'http://localhost:3000/api/admin/jobs?cleanup_preview=1&statuses=PROCESSING&olderThanDays=30'
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(jobQueueCountMock).not.toHaveBeenCalled();
  });
});
