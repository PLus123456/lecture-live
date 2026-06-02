import { beforeEach, describe, expect, it, vi } from 'vitest';

// U13 回归测试：分片上传的 Content-Length 预检——在读 body 之前按声明长度挡掉
// 明显超限的请求（OOM 防御面）。用手搓的 req（headers.get）规避 fetch 对
// content-length 的 forbidden-header 限制，且断言 formData() 不会被调用（证明预检在读 body 前生效）。
const { verifyAuthMock, enforceRateLimitMock, sessionFindUniqueMock, loadManifestMock } =
  vi.hoisted(() => ({
    verifyAuthMock: vi.fn(),
    enforceRateLimitMock: vi.fn(),
    sessionFindUniqueMock: vi.fn(),
    loadManifestMock: vi.fn(),
  }));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: { session: { findUnique: sessionFindUniqueMock } },
}));
vi.mock('@/lib/security', () => ({
  assertOwnership: vi.fn(),
  parsePositiveInteger: (v: string) => Number(v),
}));
vi.mock('@/lib/audio/asyncUploadChunkPersistence', () => ({
  loadAsyncUploadManifest: loadManifestMock,
  persistAsyncUploadChunk: vi.fn(),
}));

import { POST } from '@/app/api/sessions/[id]/async-upload/chunks/route';

const MAX_CHUNK_BYTES = 20 * 1024 * 1024;
const formDataSpy = vi.fn();

function makeReq(contentLength: string | null): Request {
  return {
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-length' ? contentLength : null),
    },
    formData: async () => {
      formDataSpy();
      throw new Error('formData() should not run when the precheck rejects');
    },
  } as unknown as Request;
}

const ctx = { params: Promise.resolve({ id: 'session-1' }) };

describe('POST /api/sessions/[id]/async-upload/chunks — Content-Length precheck', () => {
  beforeEach(() => {
    formDataSpy.mockReset();
    verifyAuthMock.mockResolvedValue({ id: 'user-1' });
    enforceRateLimitMock.mockResolvedValue(null);
    sessionFindUniqueMock.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      asyncTranscribeStatus: 'uploading_chunks',
    });
    loadManifestMock.mockResolvedValue({ totalChunks: 5 });
  });

  it('rejects with 413 when declared Content-Length exceeds the cap, before reading the body', async () => {
    const res = await POST(makeReq(String(MAX_CHUNK_BYTES + 2 * 1024 * 1024)), ctx);
    expect(res.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
  });
});
