import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../../../../../tests/utils/http';

const {
  verifyAuthMock,
  enforceApiRateLimitMock,
  sessionFindManyMock,
  sessionCreateMock,
  sessionCountMock,
  sessionAggregateMock,
  folderFindUniqueMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceApiRateLimitMock: vi.fn(),
  sessionFindManyMock: vi.fn(),
  sessionCreateMock: vi.fn(),
  sessionCountMock: vi.fn(),
  sessionAggregateMock: vi.fn(),
  folderFindUniqueMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: verifyAuthMock,
}));

vi.mock('@/lib/rateLimit', () => ({
  enforceApiRateLimit: enforceApiRateLimitMock,
}));

vi.mock('@/lib/requestLogger', () => ({
  withRequestLogging: (
    _routeName: string,
    handler: (...args: unknown[]) => unknown
  ) => handler,
}));

vi.mock('@/lib/auditLog', () => ({
  logAction: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findMany: sessionFindManyMock,
      create: sessionCreateMock,
      count: sessionCountMock,
      aggregate: sessionAggregateMock,
    },
    folder: {
      findUnique: folderFindUniqueMock,
    },
  },
}));

import { GET, POST } from '@/app/api/sessions/route';

describe('sessions route', () => {
  beforeEach(() => {
    verifyAuthMock.mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      role: 'ADMIN',
    });
    enforceApiRateLimitMock.mockResolvedValue(null);
  });

  it('支持分页获取当前用户会话列表', async () => {
    sessionFindManyMock.mockImplementation((args: { where?: { status?: unknown } } = {}) => {
      // liveSessions 查询：status in [RECORDING, PAUSED]
      if (args.where?.status) {
        return Promise.resolve([]);
      }
      // 主列表查询
      return Promise.resolve([
        { id: 'session-3', title: 'Third' },
        { id: 'session-2', title: 'Second' },
        { id: 'session-1', title: 'First' },
      ]);
    });
    sessionCountMock.mockResolvedValue(12);
    sessionAggregateMock.mockResolvedValue({ _sum: { durationMs: 360000 } });

    const response = await GET(
      createJsonRequest('http://localhost:3000/api/sessions?limit=2'),
      {} as never
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'private, no-cache, must-revalidate'
    );
    expect(response.headers.get('ETag')).toBeTruthy();
    await expect(
      readJson<{
        items: Array<{ id: string; title: string }>;
        nextCursor: string | null;
        totalCount: number;
        totalDurationMs: number;
      }>(response)
    ).resolves.toEqual({
      items: [
        { id: 'session-3', title: 'Third' },
        { id: 'session-2', title: 'Second' },
      ],
      nextCursor: 'session-2',
      totalCount: 12,
      totalDurationMs: 360000,
    });
    expect(sessionFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        take: 3,
      })
    );
    expect(sessionCountMock).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
    expect(sessionAggregateMock).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      _sum: { durationMs: true },
    });
  });

  it('命中 ETag 时返回 304', async () => {
    sessionFindManyMock.mockResolvedValue([
      { id: 'session-1', title: 'First' },
    ]);

    const firstResponse = await GET(
      createJsonRequest('http://localhost:3000/api/sessions'),
      {} as never
    );
    const etag = firstResponse.headers.get('ETag');

    const response = await GET(
      createJsonRequest('http://localhost:3000/api/sessions', {
        headers: { 'If-None-Match': etag ?? '' },
      }),
      {} as never
    );

    expect(response.status).toBe(304);
    await expect(response.text()).resolves.toBe('');
  });

  it('创建会话时校验文件夹归属并规范化字段', async () => {
    folderFindUniqueMock.mockResolvedValue({
      id: 'folder-1',
      userId: 'user-1',
    });
    sessionCreateMock.mockResolvedValue({
      id: 'session-1',
      title: 'Chemistry 101',
      status: 'CREATED',
    });

    const response = await POST(
      createJsonRequest('http://localhost:3000/api/sessions', {
        method: 'POST',
        body: {
          title: '  Chemistry 101  ',
          courseName: '  Organic  ',
          sourceLang: ' EN ',
          targetLang: ' zh-CN ',
          llmProvider: ' openai ',
          audioSource: 'system',
          sonioxRegion: 'EU',
          folderId: 'folder-1',
        },
      }),
      {} as never
    );

    expect(response.status).toBe(201);
    await expect(readJson<Record<string, unknown>>(response)).resolves.toEqual({
      id: 'session-1',
      title: 'Chemistry 101',
      status: 'CREATED',
    });
    expect(folderFindUniqueMock).toHaveBeenCalledWith({
      where: { id: 'folder-1' },
      select: { id: true, userId: true },
    });
    expect(sessionCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        title: 'Chemistry 101',
        status: 'CREATED',
        courseName: 'Organic',
        sourceLang: 'en',
        targetLang: 'zh',
        llmProvider: 'openai',
        audioSource: 'system_audio',
        sonioxRegion: 'eu',
        folders: { create: { folderId: 'folder-1' } },
      }),
    });
  });

  it('拒绝访问其他用户的文件夹', async () => {
    folderFindUniqueMock.mockResolvedValue({
      id: 'folder-1',
      userId: 'user-2',
    });

    const response = await POST(
      createJsonRequest('http://localhost:3000/api/sessions', {
        method: 'POST',
        body: {
          title: 'Test session',
          folderId: 'folder-1',
        },
      }),
      {} as never
    );

    expect(response.status).toBe(403);
    await expect(readJson<Record<string, string>>(response)).resolves.toEqual({
      error: 'Access denied',
    });
    expect(sessionCreateMock).not.toHaveBeenCalled();
  });
});
