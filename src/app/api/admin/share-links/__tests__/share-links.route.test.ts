import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  shareLinkFindManyMock,
  shareLinkDeleteManyMock,
  shareLinkCountMock,
  invalidateShareLinksApiCacheMock,
  notifyLiveShareLinksRevokedMock,
  getSecurityAuditRequestIdMock,
  writeSecurityAuditMock,
  logActionMock,
  transactionMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  shareLinkFindManyMock: vi.fn(),
  shareLinkDeleteManyMock: vi.fn(),
  shareLinkCountMock: vi.fn(),
  invalidateShareLinksApiCacheMock: vi.fn(),
  notifyLiveShareLinksRevokedMock: vi.fn(),
  getSecurityAuditRequestIdMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  logActionMock: vi.fn(),
  transactionMock: vi.fn(),
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
    $transaction: transactionMock,
  },
}));

vi.mock('@/lib/apiResponseCache', () => ({
  invalidateShareLinksApiCache: invalidateShareLinksApiCacheMock,
}));

vi.mock('@/lib/auditLog', () => ({
  logAction: logActionMock,
}));

vi.mock('@/lib/securityAudit', () => ({
  getSecurityAuditRequestId: getSecurityAuditRequestIdMock,
  writeSecurityAudit: writeSecurityAuditMock,
}));

vi.mock('@/lib/liveShare/revocationNotifier', () => ({
  notifyLiveShareLinksRevoked: notifyLiveShareLinksRevokedMock,
}));

import { DELETE, GET } from '@/app/api/admin/share-links/route';

const adminUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'ADMIN' as const,
};

const sensitiveLink = {
  id: 'link-1',
  sessionId: 'session-1',
  createdBy: 'user-1',
  token: 'top-secret-share-token',
  isLive: true,
  expiresAt: null,
  createdAt: new Date('2026-08-20T00:00:00.000Z'),
  session: {
    id: 'session-1',
    title: 'Lecture',
    status: 'RECORDING',
    createdAt: new Date('2026-08-20T00:00:00.000Z'),
    sourceLang: 'en',
    targetLang: 'zh',
  },
  creator: {
    id: 'user-1',
    email: 'user@example.com',
    displayName: 'User',
    role: 'USER',
  },
};

beforeEach(() => {
  requireAdminAccessMock.mockReset().mockResolvedValue({
    user: adminUser,
    response: null,
  });
  shareLinkFindManyMock.mockReset();
  shareLinkDeleteManyMock.mockReset();
  shareLinkCountMock.mockReset();
  invalidateShareLinksApiCacheMock.mockReset().mockResolvedValue(undefined);
  notifyLiveShareLinksRevokedMock.mockReset().mockResolvedValue(undefined);
  getSecurityAuditRequestIdMock.mockReset().mockReturnValue('audit-request-1');
  writeSecurityAuditMock.mockReset().mockResolvedValue({
    requestId: 'audit-request-1',
    action: 'admin.security.test',
  });
  logActionMock.mockReset();
  transactionMock.mockReset().mockImplementation(async (callback) =>
    callback({
      shareLink: { deleteMany: shareLinkDeleteManyMock },
      auditLog: { create: vi.fn() },
    })
  );
});

describe('/api/admin/share-links GET', () => {
  it('审计落盘后才返回敏感链接，审计事件不包含 token/URL', async () => {
    shareLinkFindManyMock.mockResolvedValue([sensitiveLink]);
    shareLinkCountMock.mockResolvedValue(1);

    const response = await GET(
      new Request(
        'http://localhost:3000/api/admin/share-links?keyword=top-secret-share-token&status=live',
      ),
    );

    expect(response.status).toBe(200);
    const body = await readJson<{ links: Array<{ token: string; url: string }> }>(response);
    expect(body.links[0]).toMatchObject({
      token: 'top-secret-share-token',
      url: expect.stringContaining('top-secret-share-token'),
    });
    expect(writeSecurityAuditMock).toHaveBeenCalledTimes(1);
    expect(writeSecurityAuditMock.mock.calls[0][1]).toMatchObject({
      event: 'share_links.read',
      reason: 'admin_list',
      outcome: 'SUCCESS',
      requestId: 'audit-request-1',
      target: { type: 'share_link_collection', id: 'all' },
      metadata: {
        filters: { keywordApplied: true, status: 'live' },
        page: 1,
        count: 1,
        total: 1,
      },
    });
    const auditEvent = JSON.stringify(writeSecurityAuditMock.mock.calls[0][1]);
    expect(auditEvent).not.toContain('top-secret-share-token');
    expect(auditEvent).not.toContain('/view?token=');
  });

  it('审计写入失败时返回 503，响应不泄露 token 或 URL', async () => {
    shareLinkFindManyMock.mockResolvedValue([sensitiveLink]);
    shareLinkCountMock.mockResolvedValue(1);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await GET(
      new Request('http://localhost:3000/api/admin/share-links'),
    );

    expect(response.status).toBe(503);
    const responseText = await response.text();
    expect(responseText).not.toContain('top-secret-share-token');
    expect(responseText).not.toContain('/view?token=');
  });
});

describe('/api/admin/share-links DELETE', () => {

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
    expect(writeSecurityAuditMock.mock.calls.map((call) => call[1].outcome)).toEqual([
      'ATTEMPTED',
      'SUCCESS',
      'SUCCESS',
    ]);
    expect(writeSecurityAuditMock.mock.invocationCallOrder[0]).toBeLessThan(
      shareLinkDeleteManyMock.mock.invocationCallOrder[0],
    );
    const auditEvents = JSON.stringify(
      writeSecurityAuditMock.mock.calls.map((call) => call[1]),
    );
    expect(auditEvents).not.toContain('t1');
    expect(auditEvents).not.toContain('t2');
    expect(auditEvents).not.toContain('t3');
  });

  it('部分 ID 不存在时记录 PARTIAL，不伪造 SUCCESS', async () => {
    shareLinkFindManyMock.mockResolvedValue([
      { id: 'link-1', sessionId: 'session-1', createdBy: 'user-1', token: 't1' },
    ]);
    shareLinkDeleteManyMock.mockResolvedValue({ count: 1 });

    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/admin/share-links', {
        method: 'DELETE',
        // 未命中的原始输入可能本身就是 bearer token，不得复制进审计。
        body: { ids: ['link-1', 'injected-bearer-token-value'] },
      }),
    );

    expect(response.status).toBe(200);
    expect(writeSecurityAuditMock.mock.calls.map((call) => call[1].outcome)).toEqual([
      'ATTEMPTED',
      'SUCCESS',
      'PARTIAL',
    ]);
    expect(JSON.stringify(writeSecurityAuditMock.mock.calls)).not.toContain(
      'injected-bearer-token-value',
    );
  });

  it('删除完成后缓存失效失败时记录 PARTIAL 并保留原业务 500', async () => {
    shareLinkFindManyMock.mockResolvedValue([
      { id: 'link-1', sessionId: 'session-1', createdBy: 'user-1', token: 't1' },
    ]);
    shareLinkDeleteManyMock.mockResolvedValue({ count: 1 });
    invalidateShareLinksApiCacheMock.mockRejectedValueOnce(new Error('cache down'));

    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/admin/share-links', {
        method: 'DELETE',
        body: { ids: ['link-1'] },
      }),
    );

    expect(response.status).toBe(500);
    expect(writeSecurityAuditMock.mock.calls.map((call) => call[1].outcome)).toEqual([
      'ATTEMPTED',
      'SUCCESS',
      'PARTIAL',
    ]);
  });

  it('数据库删除失败时记录 FAILED，且没有假 SUCCESS', async () => {
    shareLinkFindManyMock.mockResolvedValue([
      { id: 'link-1', sessionId: 'session-1', createdBy: 'user-1', token: 't1' },
    ]);
    shareLinkDeleteManyMock.mockRejectedValueOnce(new Error('db down'));
    writeSecurityAuditMock
      .mockResolvedValueOnce({
        requestId: 'audit-request-1',
        action: 'admin.security.share_links.delete',
      })
      .mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/admin/share-links', {
        method: 'DELETE',
        body: { ids: ['link-1'] },
      }),
    );

    expect(response.status).toBe(503);
    expect(writeSecurityAuditMock.mock.calls.map((call) => call[1].outcome)).toEqual([
      'ATTEMPTED',
      'FAILED',
    ]);
    expect(writeSecurityAuditMock.mock.calls.some((call) => call[1].outcome === 'SUCCESS')).toBe(
      false,
    );
  });

  it('删除完成但结果审计失败时返回 503，初始 ATTEMPTED 仍已落盘', async () => {
    shareLinkFindManyMock.mockResolvedValue([
      { id: 'link-1', sessionId: 'session-1', createdBy: 'user-1', token: 't1' },
    ]);
    shareLinkDeleteManyMock.mockResolvedValue({ count: 1 });
    writeSecurityAuditMock
      .mockResolvedValueOnce({
        requestId: 'audit-request-1',
        action: 'admin.security.share_links.delete',
      })
      .mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/admin/share-links', {
        method: 'DELETE',
        body: { ids: ['link-1'] },
      }),
    );

    expect(response.status).toBe(503);
    expect(shareLinkDeleteManyMock).toHaveBeenCalledTimes(1);
    expect(writeSecurityAuditMock.mock.calls[0][1].outcome).toBe('ATTEMPTED');
  });

  it('ATTEMPTED 审计无法落盘时 fail closed，不触发删除或通知', async () => {
    shareLinkFindManyMock.mockResolvedValue([
      { id: 'link-1', sessionId: 'session-1', createdBy: 'user-1', token: 't1' },
    ]);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/admin/share-links', {
        method: 'DELETE',
        body: { ids: ['link-1'] },
      }),
    );

    expect(response.status).toBe(503);
    expect(shareLinkDeleteManyMock).not.toHaveBeenCalled();
    expect(invalidateShareLinksApiCacheMock).not.toHaveBeenCalled();
    expect(notifyLiveShareLinksRevokedMock).not.toHaveBeenCalled();
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
    expect(writeSecurityAuditMock).not.toHaveBeenCalled();
  });
});
