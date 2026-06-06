import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyAuthMock, findManyMock, cascadeMock } = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  findManyMock: vi.fn(),
  cascadeMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));

vi.mock('@/lib/prisma', () => ({
  prisma: { conversation: { findMany: findManyMock } },
}));

vi.mock('@/lib/conversationCascade', () => ({
  deleteConversationsCascade: cascadeMock,
}));

vi.mock('@/lib/llm/embedding/transcriptRag', () => ({
  invalidateRagCache: vi.fn(),
}));

vi.mock('@/lib/logger', () => {
  const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: noopLogger, serializeError: () => ({}) };
});

import { GET, DELETE } from '@/app/api/conversations/route';

function getReq(qs: string) {
  return new Request(`http://localhost:3000/api/conversations${qs}`);
}
function delReq(body?: unknown) {
  return new Request('http://localhost:3000/api/conversations', {
    method: 'DELETE',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('GET /api/conversations — archived 过滤', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'u1', role: 'PRO' });
    findManyMock.mockResolvedValue([]);
  });

  it('recent 默认排除已归档（where.archived=false）', async () => {
    await GET(getReq('?recent=20'));
    expect(findManyMock.mock.calls[0][0].where).toEqual({
      userId: 'u1',
      archived: false,
    });
  });

  it('recent + includeArchived=true 不加 archived 过滤', async () => {
    await GET(getReq('?recent=20&includeArchived=true'));
    expect(findManyMock.mock.calls[0][0].where).toEqual({ userId: 'u1' });
  });

  it('scope=global 默认排除已归档', async () => {
    await GET(getReq('?scope=global'));
    expect(findManyMock.mock.calls[0][0].where).toEqual({
      userId: 'u1',
      sessionId: null,
      archived: false,
    });
  });
});

describe('DELETE /api/conversations — 批量清理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'u1', role: 'PRO' });
    findManyMock.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    cascadeMock.mockResolvedValue(2);
  });

  it('{ all: true } → 删本人全部，返回 deleted', async () => {
    const res = await DELETE(delReq({ all: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2 });
    expect(findManyMock.mock.calls[0][0].where).toEqual({ userId: 'u1' });
    expect(cascadeMock).toHaveBeenCalledWith(['a', 'b']);
  });

  it('{ archivedOnly: true } → 仅删已归档（where.archived=true）', async () => {
    await DELETE(delReq({ archivedOnly: true }));
    expect(findManyMock.mock.calls[0][0].where).toEqual({
      userId: 'u1',
      archived: true,
    });
  });

  it('未指定 all/archivedOnly → 400，不删', async () => {
    const res = await DELETE(delReq({}));
    expect(res.status).toBe(400);
    expect(cascadeMock).not.toHaveBeenCalled();
  });

  it('无可删对话 → deleted:0，不调级联', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const res = await DELETE(delReq({ all: true }));
    expect(await res.json()).toEqual({ deleted: 0 });
    expect(cascadeMock).not.toHaveBeenCalled();
  });

  it('未登录 → 401', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);
    const res = await DELETE(delReq({ all: true }));
    expect(res.status).toBe(401);
  });
});
