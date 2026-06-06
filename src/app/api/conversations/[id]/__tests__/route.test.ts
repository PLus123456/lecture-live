import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyAuthMock, findUniqueMock, cascadeMock, updateMock } = vi.hoisted(
  () => ({
    verifyAuthMock: vi.fn(),
    findUniqueMock: vi.fn(),
    cascadeMock: vi.fn(),
    updateMock: vi.fn(),
  })
);

vi.mock('@/lib/auth', () => ({
  verifyAuth: verifyAuthMock,
}));

vi.mock('@/lib/conversationCascade', () => ({
  deleteConversationsCascade: cascadeMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    conversation: {
      findUnique: findUniqueMock,
      update: updateMock,
    },
  },
}));

vi.mock('@/lib/logger', () => {
  const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => noopLogger,
  };
  return {
    logger: noopLogger,
    serializeError: (err: unknown) =>
      err instanceof Error ? { message: err.message } : { message: String(err) },
  };
});

import { GET, DELETE, PATCH } from '@/app/api/conversations/[id]/route';

function makeReq(method: string, body?: unknown) {
  return new Request('http://localhost:3000/api/conversations/conv-1', {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('DELETE /api/conversations/[id]', () => {
  beforeEach(() => {
    verifyAuthMock.mockReset();
    findUniqueMock.mockReset();
    cascadeMock.mockReset();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    findUniqueMock.mockResolvedValue({ id: 'conv-1', userId: 'user-1' });
    cascadeMock.mockResolvedValue(1);
  });

  it('owner 删除 → 200，级联清理被调用', async () => {
    const res = await DELETE(makeReq('DELETE'), makeParams('conv-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(cascadeMock).toHaveBeenCalledWith(['conv-1']);
  });

  it('未登录 → 401，不删', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);
    const res = await DELETE(makeReq('DELETE'), makeParams('conv-1'));
    expect(res.status).toBe(401);
    expect(cascadeMock).not.toHaveBeenCalled();
  });

  it('对话不存在 → 404，不删', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const res = await DELETE(makeReq('DELETE'), makeParams('conv-1'));
    expect(res.status).toBe(404);
    expect(cascadeMock).not.toHaveBeenCalled();
  });

  it('非 owner 非 ADMIN → 403，不删', async () => {
    verifyAuthMock.mockResolvedValueOnce({ id: 'user-2', role: 'PRO' });
    const res = await DELETE(makeReq('DELETE'), makeParams('conv-1'));
    expect(res.status).toBe(403);
    expect(cascadeMock).not.toHaveBeenCalled();
  });

  it('无主对话（userId=null）非 ADMIN → 403，不删', async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 'conv-1', userId: null });
    const res = await DELETE(makeReq('DELETE'), makeParams('conv-1'));
    expect(res.status).toBe(403);
    expect(cascadeMock).not.toHaveBeenCalled();
  });

  it('ADMIN 可跨用户删（含无主对话）→ 200', async () => {
    verifyAuthMock.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN' });
    findUniqueMock.mockResolvedValueOnce({ id: 'conv-1', userId: 'user-9' });
    const res = await DELETE(makeReq('DELETE'), makeParams('conv-1'));
    expect(res.status).toBe(200);
    expect(cascadeMock).toHaveBeenCalledWith(['conv-1']);
  });

  it('级联清理抛错 → 500', async () => {
    cascadeMock.mockRejectedValueOnce(new Error('boom'));
    const res = await DELETE(makeReq('DELETE'), makeParams('conv-1'));
    expect(res.status).toBe(500);
  });
});

describe('GET /api/conversations/[id]', () => {
  beforeEach(() => {
    verifyAuthMock.mockReset();
    findUniqueMock.mockReset();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    findUniqueMock.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      title: '聊点什么',
      startedAt: new Date('2026-06-01T00:00:00.000Z'),
      endedAt: null,
      degradationLevel: 2,
      sessionId: 'sess-1',
      sessions: [{ sessionId: 'sess-2' }],
      _count: { messages: 5 },
    });
  });

  it('owner → 200，返回元数据 + 合并 sessionIds', async () => {
    const res = await GET(makeReq('GET'), makeParams('conv-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversation).toMatchObject({
      id: 'conv-1',
      title: '聊点什么',
      degradationLevel: 2,
      messageCount: 5,
      sessionIds: ['sess-1', 'sess-2'],
    });
  });

  it('未登录 → 401', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);
    const res = await GET(makeReq('GET'), makeParams('conv-1'));
    expect(res.status).toBe(401);
  });

  it('对话不存在 → 404', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const res = await GET(makeReq('GET'), makeParams('conv-1'));
    expect(res.status).toBe(404);
  });

  it('非 owner 非 ADMIN → 403', async () => {
    verifyAuthMock.mockResolvedValueOnce({ id: 'user-2', role: 'PRO' });
    const res = await GET(makeReq('GET'), makeParams('conv-1'));
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/conversations/[id] (重命名)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    findUniqueMock.mockResolvedValue({ id: 'conv-1', userId: 'user-1' });
    updateMock.mockResolvedValue({});
  });

  it('owner 改名 → 200，落库 trim 后标题', async () => {
    const res = await PATCH(makeReq('PATCH', { title: '  新标题  ' }), makeParams('conv-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, title: '新标题' });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { title: '新标题' },
    });
  });

  it('归档 → 200，落库 archived=true', async () => {
    const res = await PATCH(makeReq('PATCH', { archived: true }), makeParams('conv-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, archived: true });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { archived: true },
    });
  });

  it('archived 非 boolean → 400', async () => {
    const res = await PATCH(
      makeReq('PATCH', { archived: 'yes' }),
      makeParams('conv-1')
    );
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('既无 title 也无 archived → 400', async () => {
    const res = await PATCH(makeReq('PATCH', {}), makeParams('conv-1'));
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('空标题 → 400，不落库', async () => {
    const res = await PATCH(makeReq('PATCH', { title: '   ' }), makeParams('conv-1'));
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('缺 title → 400', async () => {
    const res = await PATCH(makeReq('PATCH', {}), makeParams('conv-1'));
    expect(res.status).toBe(400);
  });

  it('超长(>100) → 400', async () => {
    const res = await PATCH(
      makeReq('PATCH', { title: 'x'.repeat(101) }),
      makeParams('conv-1')
    );
    expect(res.status).toBe(400);
  });

  it('非 owner 非 ADMIN → 403，不落库', async () => {
    verifyAuthMock.mockResolvedValueOnce({ id: 'user-2', role: 'PRO' });
    const res = await PATCH(makeReq('PATCH', { title: 'x' }), makeParams('conv-1'));
    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('对话不存在 → 404', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const res = await PATCH(makeReq('PATCH', { title: 'x' }), makeParams('conv-1'));
    expect(res.status).toBe(404);
  });

  it('未登录 → 401', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);
    const res = await PATCH(makeReq('PATCH', { title: 'x' }), makeParams('conv-1'));
    expect(res.status).toBe(401);
  });
});
