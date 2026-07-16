import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  shareLinkFindManyMock,
  shareLinkDeleteManyMock,
  shareLinkCountMock,
  invalidateShareLinksApiCacheMock,
  notifyLiveShareLinksRevokedMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  shareLinkFindManyMock: vi.fn(),
  shareLinkDeleteManyMock: vi.fn(),
  shareLinkCountMock: vi.fn(),
  invalidateShareLinksApiCacheMock: vi.fn(),
  notifyLiveShareLinksRevokedMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    shareLink: {
      findMany: shareLinkFindManyMock,
      deleteMany: shareLinkDeleteManyMock,
      count: shareLinkCountMock,
    },
  },
}));

vi.mock('@/lib/apiResponseCache', () => ({
  invalidateShareLinksApiCache: invalidateShareLinksApiCacheMock,
}));

vi.mock('@/lib/auditLog', () => ({
  logAction: vi.fn(),
}));

vi.mock('@/lib/liveShare/revocationNotifier', () => ({
  notifyLiveShareLinksRevoked: notifyLiveShareLinksRevokedMock,
}));

import { DELETE } from '@/app/api/admin/share-links/route';

describe('/api/admin/share-links DELETE', () => {
  beforeEach(() => {
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' },
      response: null,
    });
    invalidateShareLinksApiCacheMock.mockResolvedValue(undefined);
    notifyLiveShareLinksRevokedMock.mockResolvedValue(undefined);
  });

  it('删除链接后按受影响 session 通知 WS 驱逐已连接观众', async () => {
    shareLinkFindManyMock.mockResolvedValue([
      { id: 'link-1', sessionId: 'session-1', createdBy: 'user-1', token: 't1' },
      { id: 'link-2', sessionId: 'session-2', createdBy: 'user-2', token: 't2' },
      { id: 'link-3', sessionId: 'session-1', createdBy: 'user-1', token: 't3' },
    ]);
    shareLinkDeleteManyMock.mockResolvedValue({ count: 3 });

    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/admin/share-links', {
        method: 'DELETE',
        body: { ids: ['link-1', 'link-2', 'link-3'] },
      })
    );

    expect(response.status).toBe(200);
    await expect(readJson<Record<string, number>>(response)).resolves.toEqual({
      deleted: 3,
    });

    // 每个受影响 session 各通知一次（session-1 有两条链接也只通知一次）
    expect(notifyLiveShareLinksRevokedMock).toHaveBeenCalledTimes(2);
    expect(notifyLiveShareLinksRevokedMock).toHaveBeenCalledWith(
      'session-1',
      'revoke'
    );
    expect(notifyLiveShareLinksRevokedMock).toHaveBeenCalledWith(
      'session-2',
      'revoke'
    );
  });

  it('未提供 ids 时返回 400 且不通知', async () => {
    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/admin/share-links', {
        method: 'DELETE',
        body: {},
      })
    );

    expect(response.status).toBe(400);
    expect(notifyLiveShareLinksRevokedMock).not.toHaveBeenCalled();
  });
});
