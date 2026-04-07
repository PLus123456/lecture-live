import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../tests/utils/http';

const {
  verifyAuthMock,
  enforceRateLimitMock,
  sessionFindUniqueMock,
  shareLinkFindManyMock,
  shareLinkFindFirstMock,
  shareLinkUpdateMock,
  shareLinkCreateMock,
  shareLinkUpdateManyMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  shareLinkFindManyMock: vi.fn(),
  shareLinkFindFirstMock: vi.fn(),
  shareLinkUpdateMock: vi.fn(),
  shareLinkCreateMock: vi.fn(),
  shareLinkUpdateManyMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: verifyAuthMock,
}));

vi.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: enforceRateLimitMock,
}));

vi.mock('@/lib/auditLog', () => ({
  logAction: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findUnique: sessionFindUniqueMock,
    },
    shareLink: {
      findMany: shareLinkFindManyMock,
      findFirst: shareLinkFindFirstMock,
      update: shareLinkUpdateMock,
      create: shareLinkCreateMock,
      updateMany: shareLinkUpdateManyMock,
    },
  },
}));

import { DELETE, GET, POST } from '@/app/api/share/create/route';

beforeAll(() => {
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
});

describe('/api/share/create route', () => {
  beforeEach(() => {
    verifyAuthMock.mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      role: 'ADMIN',
    });
    enforceRateLimitMock.mockResolvedValue(null);
    sessionFindUniqueMock.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      status: 'RECORDING',
    });
  });

  it('列出当前用户的分享链接并拼接公开访问 URL', async () => {
    shareLinkFindManyMock.mockResolvedValue([
      {
        id: 'link-1',
        token: 'share-token',
        isLive: true,
        expiresAt: null,
        createdAt: new Date('2026-03-27T10:00:00.000Z'),
        sessionId: 'session-1',
        session: {
          id: 'session-1',
          title: 'Realtime lecture',
          status: 'RECORDING',
          createdAt: new Date('2026-03-27T09:00:00.000Z'),
          sourceLang: 'en',
          targetLang: 'zh',
        },
      },
    ]);

    const response = await GET(
      createJsonRequest('http://localhost:3000/api/share/create')
    );

    expect(response.status).toBe(200);
    await expect(readJson<Array<Record<string, unknown>>>(response)).resolves.toEqual([
      expect.objectContaining({
        id: 'link-1',
        token: 'share-token',
        isLive: true,
        url: 'http://localhost:3000/session/session-1/view?token=share-token',
      }),
    ]);
  });

  it('复用现有 live link 并更新时间', async () => {
    shareLinkFindFirstMock.mockResolvedValue({
      id: 'link-1',
      token: 'share-token',
      isLive: true,
      expiresAt: null,
    });
    shareLinkUpdateMock.mockResolvedValue({
      id: 'link-1',
      token: 'share-token',
      isLive: true,
      expiresAt: new Date('2026-03-27T12:00:00.000Z'),
    });

    const response = await POST(
      createJsonRequest('http://localhost:3000/api/share/create', {
        method: 'POST',
        body: {
          sessionId: 'session-1',
          isLive: true,
          expiresInHours: 2,
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(readJson<Record<string, unknown>>(response)).resolves.toEqual(
      expect.objectContaining({
        id: 'link-1',
        token: 'share-token',
        isLive: true,
        url: 'http://localhost:3000/session/session-1/view?token=share-token',
      })
    );
    expect(shareLinkUpdateMock).toHaveBeenCalledWith({
      where: { id: 'link-1' },
      data: { expiresAt: expect.any(Date) },
    });
    expect(shareLinkCreateMock).not.toHaveBeenCalled();
  });

  it('停用会话的实时分享链接', async () => {
    shareLinkUpdateManyMock.mockResolvedValue({ count: 1 });

    const response = await DELETE(
      createJsonRequest('http://localhost:3000/api/share/create', {
        method: 'DELETE',
        body: { sessionId: 'session-1' },
      })
    );

    expect(response.status).toBe(200);
    await expect(readJson<Record<string, boolean>>(response)).resolves.toEqual({
      success: true,
    });
    expect(shareLinkUpdateManyMock).toHaveBeenCalledWith({
      where: {
        sessionId: 'session-1',
        createdBy: 'user-1',
      },
      data: {
        isLive: false,
        expiresAt: expect.any(Date),
      },
    });
  });
});
