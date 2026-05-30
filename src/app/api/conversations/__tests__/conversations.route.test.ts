import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../tests/utils/http';

const {
  verifyAuthMock,
  conversationFindManyMock,
  conversationCreateMock,
  conversationUpdateManyMock,
  conversationSessionCreateManyMock,
  sessionFindUniqueMock,
  sessionCountMock,
  transactionMock,
  invalidateRagCacheMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  conversationFindManyMock: vi.fn(),
  conversationCreateMock: vi.fn(),
  conversationUpdateManyMock: vi.fn(),
  conversationSessionCreateManyMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  sessionCountMock: vi.fn(),
  transactionMock: vi.fn(),
  invalidateRagCacheMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: verifyAuthMock,
}));

vi.mock('@/lib/llm/embedding/transcriptRag', () => ({
  invalidateRagCache: invalidateRagCacheMock,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
  serializeError: (err: unknown) => ({ message: String(err) }),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    conversation: {
      findMany: conversationFindManyMock,
      create: conversationCreateMock,
      updateMany: conversationUpdateManyMock,
    },
    conversationSession: {
      createMany: conversationSessionCreateManyMock,
    },
    session: {
      findUnique: sessionFindUniqueMock,
      count: sessionCountMock,
    },
    $transaction: transactionMock,
  },
}));

import { GET, POST } from '@/app/api/conversations/route';

describe('GET /api/conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({
      id: 'user-1',
      email: 'u@example.com',
      role: 'PRO',
    });
  });

  it('未登录返回 401', async () => {
    verifyAuthMock.mockResolvedValue(null);
    const response = await GET(
      createJsonRequest('http://localhost:3000/api/conversations?sessionId=s1')
    );
    expect(response.status).toBe(401);
  });

  it('?recent=N 返回最近 N 条，并附 sessionIds', async () => {
    conversationFindManyMock.mockResolvedValue([
      {
        id: 'c1',
        title: 'Hello',
        startedAt: new Date('2026-05-22T00:00:00Z'),
        endedAt: null,
        degradationLevel: 1,
        sessionId: 's1',
        sessions: [{ sessionId: 's1' }, { sessionId: 's2' }],
        _count: { messages: 3 },
      },
    ]);

    const response = await GET(
      createJsonRequest('http://localhost:3000/api/conversations?recent=5')
    );
    expect(response.status).toBe(200);
    const body = await readJson<{ conversations: Array<{ id: string; sessionIds: string[]; messageCount: number }> }>(response);
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0].id).toBe('c1');
    expect(body.conversations[0].sessionIds).toEqual(['s1', 's2']);
    expect(body.conversations[0].messageCount).toBe(3);

    expect(conversationFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 5,
        orderBy: { startedAt: 'desc' },
        where: { userId: 'user-1' },
      })
    );
  });

  it('?recent 越界返回 400', async () => {
    const r1 = await GET(
      createJsonRequest('http://localhost:3000/api/conversations?recent=0')
    );
    expect(r1.status).toBe(400);
    const r2 = await GET(
      createJsonRequest('http://localhost:3000/api/conversations?recent=51')
    );
    expect(r2.status).toBe(400);
    const r3 = await GET(
      createJsonRequest('http://localhost:3000/api/conversations?recent=abc')
    );
    expect(r3.status).toBe(400);
  });

  it('?scope=global 仅返回本人拥有且无 legacy sessionId 的对话（含零录音）', async () => {
    conversationFindManyMock.mockResolvedValue([
      {
        id: 'c-global',
        title: null,
        startedAt: new Date('2026-05-22T01:00:00Z'),
        endedAt: null,
        degradationLevel: 1,
        sessionId: null,
        sessions: [{ sessionId: 's2' }],
        _count: { messages: 0 },
      },
    ]);

    const response = await GET(
      createJsonRequest('http://localhost:3000/api/conversations?scope=global')
    );
    expect(response.status).toBe(200);
    const body = await readJson<{ conversations: Array<{ id: string; sessionIds: string[] }> }>(response);
    expect(body.conversations[0].sessionIds).toEqual(['s2']);

    const call = conversationFindManyMock.mock.calls[0][0];
    expect(call.where).toEqual({
      userId: 'user-1',
      sessionId: null,
    });
    expect(call.take).toBe(50);
  });

  it('?sessionId=xxx 沿用旧行为（向后兼容）', async () => {
    sessionFindUniqueMock.mockResolvedValue({ userId: 'user-1' });
    conversationFindManyMock.mockResolvedValue([
      {
        id: 'c1',
        title: 'A',
        startedAt: new Date('2026-05-22T00:00:00Z'),
        endedAt: null,
        degradationLevel: 1,
        sessionId: 's1',
        sessions: [],
        _count: { messages: 1 },
      },
    ]);

    const response = await GET(
      createJsonRequest('http://localhost:3000/api/conversations?sessionId=s1')
    );
    expect(response.status).toBe(200);
    const body = await readJson<{ conversations: Array<{ id: string; sessionIds: string[] }> }>(response);
    expect(body.conversations[0].sessionIds).toEqual(['s1']);
  });

  it('?sessionId 不存在返回 404', async () => {
    sessionFindUniqueMock.mockResolvedValue(null);
    const response = await GET(
      createJsonRequest('http://localhost:3000/api/conversations?sessionId=bad')
    );
    expect(response.status).toBe(404);
  });

  it('?sessionId 属于他人返回 404', async () => {
    sessionFindUniqueMock.mockResolvedValue({ userId: 'someone-else' });
    const response = await GET(
      createJsonRequest('http://localhost:3000/api/conversations?sessionId=other')
    );
    expect(response.status).toBe(404);
  });

  it('无参数返回 400', async () => {
    const response = await GET(
      createJsonRequest('http://localhost:3000/api/conversations')
    );
    expect(response.status).toBe(400);
  });
});

describe('POST /api/conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({
      id: 'user-1',
      email: 'u@example.com',
      role: 'PRO',
    });
  });

  it('未登录返回 401', async () => {
    verifyAuthMock.mockResolvedValue(null);
    const response = await POST(
      createJsonRequest('http://localhost:3000/api/conversations', {
        method: 'POST',
        body: {},
      })
    );
    expect(response.status).toBe(401);
  });

  it('sessionId 与 recordingIds 同时提供返回 400', async () => {
    const response = await POST(
      createJsonRequest('http://localhost:3000/api/conversations', {
        method: 'POST',
        body: { sessionId: 's1', recordingIds: ['s2'] },
      })
    );
    expect(response.status).toBe(400);
  });

  it('recordingIds 非字符串数组返回 400', async () => {
    const response = await POST(
      createJsonRequest('http://localhost:3000/api/conversations', {
        method: 'POST',
        body: { recordingIds: [1, 2] },
      })
    );
    expect(response.status).toBe(400);
  });

  it('recordingIds 中有不属于用户的录音返回 403', async () => {
    sessionCountMock.mockResolvedValue(1); // only 1 of 2 owned
    const response = await POST(
      createJsonRequest('http://localhost:3000/api/conversations', {
        method: 'POST',
        body: { recordingIds: ['s1', 'bad'] },
      })
    );
    expect(response.status).toBe(403);
  });

  it('recordingIds=[] 创建零录音全局对话（200），且写入 userId', async () => {
    const createConvMock = vi.fn().mockResolvedValue({
      id: 'c-new',
      title: null,
      startedAt: new Date('2026-05-22T01:00:00Z'),
      endedAt: null,
      degradationLevel: 1,
      sessionId: null,
    });
    transactionMock.mockImplementation(async (cb) => {
      return cb({
        conversation: { create: createConvMock },
        conversationSession: { createMany: vi.fn() },
      });
    });

    const response = await POST(
      createJsonRequest('http://localhost:3000/api/conversations', {
        method: 'POST',
        body: { recordingIds: [] },
      })
    );
    expect(response.status).toBe(200);
    const body = await readJson<{ conversation: { id: string; sessionIds: string[] } }>(response);
    expect(body.conversation.id).toBe('c-new');
    expect(body.conversation.sessionIds).toEqual([]);
    // 核心：零录音全局对话创建即带 userId（不再无主）
    expect(createConvMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sessionId: null, userId: 'user-1' } })
    );
  });

  it('recordingIds=["s1","s2"] 创建对话并插入 junction 行', async () => {
    sessionCountMock.mockResolvedValue(2);
    const createSessionMock = vi.fn();
    transactionMock.mockImplementation(async (cb) => {
      return cb({
        conversation: {
          create: vi.fn().mockResolvedValue({
            id: 'c-new',
            title: null,
            startedAt: new Date('2026-05-22T01:00:00Z'),
            endedAt: null,
            degradationLevel: 1,
            sessionId: null,
          }),
        },
        conversationSession: {
          createMany: createSessionMock,
        },
      });
    });

    const response = await POST(
      createJsonRequest('http://localhost:3000/api/conversations', {
        method: 'POST',
        body: { recordingIds: ['s1', 's2'] },
      })
    );
    expect(response.status).toBe(200);
    expect(createSessionMock).toHaveBeenCalledWith({
      data: [
        { conversationId: 'c-new', sessionId: 's1' },
        { conversationId: 'c-new', sessionId: 's2' },
      ],
    });
    const body = await readJson<{ conversation: { sessionIds: string[] } }>(response);
    expect(body.conversation.sessionIds).toEqual(['s1', 's2']);
  });

  it('legacy sessionId 关闭活跃对话并新建（向后兼容）', async () => {
    sessionFindUniqueMock.mockResolvedValue({ userId: 'user-1' });
    transactionMock.mockResolvedValue([
      { count: 1 },
      {
        id: 'c-new',
        title: null,
        startedAt: new Date('2026-05-22T01:00:00Z'),
        endedAt: null,
        degradationLevel: 1,
        sessionId: 's1',
        sessions: [],
      },
    ]);

    const response = await POST(
      createJsonRequest('http://localhost:3000/api/conversations', {
        method: 'POST',
        body: { sessionId: 's1' },
      })
    );
    expect(response.status).toBe(200);
    expect(invalidateRagCacheMock).toHaveBeenCalledWith('s1');
    const body = await readJson<{ conversation: { id: string; sessionIds: string[] } }>(response);
    expect(body.conversation.sessionIds).toEqual(['s1']);
    // legacy 单录音对话创建也带 userId
    expect(conversationCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { sessionId: 's1', userId: 'user-1' },
      })
    );
  });

  it('legacy sessionId 不存在返回 404', async () => {
    sessionFindUniqueMock.mockResolvedValue(null);
    const response = await POST(
      createJsonRequest('http://localhost:3000/api/conversations', {
        method: 'POST',
        body: { sessionId: 'bad' },
      })
    );
    expect(response.status).toBe(404);
  });

  it('空 body 视作 {} 创建零录音全局对话', async () => {
    transactionMock.mockImplementation(async (cb) => {
      return cb({
        conversation: {
          create: vi.fn().mockResolvedValue({
            id: 'c-empty',
            title: null,
            startedAt: new Date('2026-05-22T01:00:00Z'),
            endedAt: null,
            degradationLevel: 1,
            sessionId: null,
          }),
        },
        conversationSession: {
          createMany: vi.fn(),
        },
      });
    });

    // 不带 body 的 POST
    const req = new Request('http://localhost:3000/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(req);
    expect(response.status).toBe(200);
  });
});
