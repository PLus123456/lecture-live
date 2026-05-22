import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../tests/utils/http';

const {
  verifyAuthMock,
  conversationFindUniqueMock,
  conversationSessionFindManyMock,
  conversationSessionCreateManyMock,
  conversationSessionDeleteManyMock,
  sessionCountMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  conversationFindUniqueMock: vi.fn(),
  conversationSessionFindManyMock: vi.fn(),
  conversationSessionCreateManyMock: vi.fn(),
  conversationSessionDeleteManyMock: vi.fn(),
  sessionCountMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: verifyAuthMock,
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
      findUnique: conversationFindUniqueMock,
    },
    conversationSession: {
      findMany: conversationSessionFindManyMock,
      createMany: conversationSessionCreateManyMock,
      deleteMany: conversationSessionDeleteManyMock,
    },
    session: {
      count: sessionCountMock,
    },
  },
}));

import { GET, POST, DELETE } from '@/app/api/conversations/[id]/recordings/route';

const paramsP = (id: string) => Promise.resolve({ id });

function mockOwnedConversation(opts?: { sessionId?: string | null; junctionUserIds?: string[] }) {
  conversationFindUniqueMock.mockResolvedValue({
    id: 'c1',
    sessionId: opts?.sessionId ?? null,
    session: opts?.sessionId
      ? { userId: (opts.junctionUserIds && opts.junctionUserIds[0]) ?? 'user-1' }
      : null,
    sessions: (opts?.junctionUserIds ?? ['user-1']).map((uid) => ({
      session: { userId: uid },
    })),
  });
}

describe('recordings route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({
      id: 'user-1',
      email: 'u@example.com',
      role: 'PRO',
    });
  });

  describe('GET', () => {
    it('未登录返回 401', async () => {
      verifyAuthMock.mockResolvedValue(null);
      const response = await GET(
        createJsonRequest('http://localhost:3000/api/conversations/c1/recordings'),
        { params: paramsP('c1') }
      );
      expect(response.status).toBe(401);
    });

    it('对话不存在返回 404', async () => {
      conversationFindUniqueMock.mockResolvedValue(null);
      const response = await GET(
        createJsonRequest('http://localhost:3000/api/conversations/c1/recordings'),
        { params: paramsP('c1') }
      );
      expect(response.status).toBe(404);
    });

    it('对话不属于当前用户返回 403', async () => {
      mockOwnedConversation({ junctionUserIds: ['someone-else'] });
      const response = await GET(
        createJsonRequest('http://localhost:3000/api/conversations/c1/recordings'),
        { params: paramsP('c1') }
      );
      expect(response.status).toBe(403);
    });

    it('返回挂载的录音列表', async () => {
      mockOwnedConversation();
      conversationSessionFindManyMock.mockResolvedValue([
        {
          sessionId: 's1',
          addedAt: new Date('2026-05-22T00:00:00Z'),
          session: { title: 'Math Lecture' },
        },
      ]);
      const response = await GET(
        createJsonRequest('http://localhost:3000/api/conversations/c1/recordings'),
        { params: paramsP('c1') }
      );
      expect(response.status).toBe(200);
      const body = await readJson<{ recordings: Array<{ sessionId: string; title: string }> }>(response);
      expect(body.recordings).toEqual([
        {
          sessionId: 's1',
          title: 'Math Lecture',
          addedAt: '2026-05-22T00:00:00.000Z',
        },
      ]);
    });
  });

  describe('POST', () => {
    it('对话不属于当前用户返回 403', async () => {
      mockOwnedConversation({ junctionUserIds: ['someone-else'] });
      const response = await POST(
        createJsonRequest('http://localhost:3000/api/conversations/c1/recordings', {
          method: 'POST',
          body: { sessionIds: ['s1'] },
        }),
        { params: paramsP('c1') }
      );
      expect(response.status).toBe(403);
    });

    it('sessionIds 非字符串非空数组返回 400', async () => {
      mockOwnedConversation();
      const response = await POST(
        createJsonRequest('http://localhost:3000/api/conversations/c1/recordings', {
          method: 'POST',
          body: { sessionIds: [] },
        }),
        { params: paramsP('c1') }
      );
      expect(response.status).toBe(400);
    });

    it('录音不属于当前用户返回 403', async () => {
      mockOwnedConversation();
      sessionCountMock.mockResolvedValue(0);
      const response = await POST(
        createJsonRequest('http://localhost:3000/api/conversations/c1/recordings', {
          method: 'POST',
          body: { sessionIds: ['bad'] },
        }),
        { params: paramsP('c1') }
      );
      expect(response.status).toBe(403);
    });

    it('成功挂载录音并返回更新后的列表', async () => {
      mockOwnedConversation();
      sessionCountMock.mockResolvedValue(2);
      conversationSessionFindManyMock.mockResolvedValue([
        {
          sessionId: 's1',
          addedAt: new Date('2026-05-22T00:00:00Z'),
          session: { title: 'A' },
        },
        {
          sessionId: 's2',
          addedAt: new Date('2026-05-22T00:01:00Z'),
          session: { title: 'B' },
        },
      ]);

      const response = await POST(
        createJsonRequest('http://localhost:3000/api/conversations/c1/recordings', {
          method: 'POST',
          body: { sessionIds: ['s1', 's2'] },
        }),
        { params: paramsP('c1') }
      );
      expect(response.status).toBe(200);
      expect(conversationSessionCreateManyMock).toHaveBeenCalledWith({
        data: [
          { conversationId: 'c1', sessionId: 's1' },
          { conversationId: 'c1', sessionId: 's2' },
        ],
        skipDuplicates: true,
      });
      const body = await readJson<{ recordings: Array<{ sessionId: string }> }>(response);
      expect(body.recordings.map((r) => r.sessionId)).toEqual(['s1', 's2']);
    });
  });

  describe('DELETE', () => {
    it('对话不属于当前用户返回 403', async () => {
      mockOwnedConversation({ junctionUserIds: ['someone-else'] });
      const response = await DELETE(
        createJsonRequest('http://localhost:3000/api/conversations/c1/recordings', {
          method: 'DELETE',
          body: { sessionIds: ['s1'] },
        }),
        { params: paramsP('c1') }
      );
      expect(response.status).toBe(403);
    });

    it('成功删除并返回更新后的列表', async () => {
      mockOwnedConversation();
      conversationSessionFindManyMock.mockResolvedValue([]);

      const response = await DELETE(
        createJsonRequest('http://localhost:3000/api/conversations/c1/recordings', {
          method: 'DELETE',
          body: { sessionIds: ['s1'] },
        }),
        { params: paramsP('c1') }
      );
      expect(response.status).toBe(200);
      expect(conversationSessionDeleteManyMock).toHaveBeenCalledWith({
        where: { conversationId: 'c1', sessionId: { in: ['s1'] } },
      });
      const body = await readJson<{ recordings: Array<unknown> }>(response);
      expect(body.recordings).toEqual([]);
    });
  });
});
