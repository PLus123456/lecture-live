import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthMock,
  enforceRateLimitMock,
  sessionFindUniqueMock,
  sessionUpdateManyMock,
  reserveTranscriptionMinutesMock,
  releaseTranscriptionMinutesMock,
  initAsyncUploadMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  sessionUpdateManyMock: vi.fn(),
  reserveTranscriptionMinutesMock: vi.fn(),
  releaseTranscriptionMinutesMock: vi.fn(),
  initAsyncUploadMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: verifyAuthMock,
}));

vi.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: enforceRateLimitMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findUnique: sessionFindUniqueMock,
      // U42：状态机守卫改用原子 updateMany（仅 null/uploading_chunks/failed/canceled 可 init）
      updateMany: sessionUpdateManyMock,
    },
  },
}));

vi.mock('@/lib/quota', () => ({
  reserveTranscriptionMinutes: reserveTranscriptionMinutesMock,
  releaseTranscriptionMinutes: releaseTranscriptionMinutesMock,
}));

vi.mock('@/lib/audio/asyncUploadChunkPersistence', () => ({
  initAsyncUpload: initAsyncUploadMock,
}));

// 用真实的 security 工具（parsePositiveInteger / sanitizeTextInput / assertOwnership）
// 让 body 校验链真实跑，仅 mock 外部依赖。

import { POST } from '@/app/api/sessions/[id]/async-upload/init/route';

const CHUNK_SIZE = 20 * 1024 * 1024;

function makeReq(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/sessions/s-1/async-upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// 默认一个合法 body：30MB 音频，单片。
function validBody(extra: Record<string, unknown> = {}) {
  return {
    originalFileName: 'lecture.mp3',
    originalMimeType: 'audio/mpeg',
    originalSize: 30 * 1024 * 1024,
    totalChunks: 2,
    chunkSize: CHUNK_SIZE,
    ...extra,
  };
}

const params = Promise.resolve({ id: 's-1' });

describe('POST async-upload/init — 原子配额预留门禁', () => {
  beforeEach(() => {
    verifyAuthMock.mockReset();
    enforceRateLimitMock.mockReset();
    sessionFindUniqueMock.mockReset();
    sessionUpdateManyMock.mockReset();
    reserveTranscriptionMinutesMock.mockReset();
    releaseTranscriptionMinutesMock.mockReset();
    initAsyncUploadMock.mockReset();

    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'FREE' });
    enforceRateLimitMock.mockResolvedValue(null);
    sessionFindUniqueMock.mockResolvedValue({
      id: 's-1',
      userId: 'user-1',
      asyncTranscribeStatus: null,
    });
    // 默认：状态机守卫 claim 成功（count=1）
    sessionUpdateManyMock.mockResolvedValue({ count: 1 });
    reserveTranscriptionMinutesMock.mockResolvedValue(true);
    releaseTranscriptionMinutesMock.mockResolvedValue(undefined);
    initAsyncUploadMock.mockResolvedValue({
      totalChunks: 2,
      chunkSize: CHUNK_SIZE,
      receivedSeqs: [],
    });
  });

  it('额度足够：预留成功 → 初始化并返回 manifest，结束时释放预留（避免与完成时扣费双重计费）', async () => {
    const res = await POST(makeReq(validBody()), { params });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledTimes(1);
    expect(initAsyncUploadMock).toHaveBeenCalledTimes(1);
    // 准入预留必须在请求结束前释放（finally）
    expect(releaseTranscriptionMinutesMock).toHaveBeenCalledTimes(1);
    const [reservedArgs] = reserveTranscriptionMinutesMock.mock.calls;
    const [releasedArgs] = releaseTranscriptionMinutesMock.mock.calls;
    // 预留与释放的分钟一致
    expect(releasedArgs[1]).toBe(reservedArgs[1]);
  });

  it('额度不足：reserve 返回 false → 403，不初始化、不释放', async () => {
    reserveTranscriptionMinutesMock.mockResolvedValueOnce(false);

    const res = await POST(makeReq(validBody()), { params });

    expect(res.status).toBe(403);
    expect(initAsyncUploadMock).not.toHaveBeenCalled();
    expect(releaseTranscriptionMinutesMock).not.toHaveBeenCalled();
  });

  it('投影：前端声明时长 5 分钟 → 预留按 ceil(分钟)=5（而非按字节粗估）', async () => {
    await POST(
      makeReq(validBody({ estimatedDurationMs: 5 * 60_000 })),
      { params }
    );

    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledWith('user-1', 5);
  });

  it('无声明时长：按文件大小粗估（音频 ~1MB/min）→ 30MB ≈ 30 分钟', async () => {
    await POST(makeReq(validBody()), { params });

    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledWith('user-1', 30);
  });

  it('视频无声明时长：按 ~5MB/min 粗估 → 50MB ≈ 10 分钟', async () => {
    await POST(
      makeReq(
        validBody({
          originalMimeType: 'video/mp4',
          originalSize: 50 * 1024 * 1024,
          // 50MB 需要 ceil(50/20)=3 片，否则分片数学校验先 400
          totalChunks: 3,
        })
      ),
      { params }
    );

    expect(reserveTranscriptionMinutesMock).toHaveBeenCalledWith('user-1', 10);
  });

  it('initAsyncUpload 抛错 → 500，但 finally 仍释放预留（不泄漏额度）', async () => {
    initAsyncUploadMock.mockRejectedValueOnce(new Error('disk full'));

    const res = await POST(makeReq(validBody()), { params });

    expect(res.status).toBe(500);
    expect(releaseTranscriptionMinutesMock).toHaveBeenCalledTimes(1);
  });

  it('U42 状态机守卫：会话已在进行中（claim count=0）→ 409，不写 manifest，释放预留', async () => {
    sessionFindUniqueMock.mockResolvedValueOnce({
      id: 's-1',
      userId: 'user-1',
      asyncTranscribeStatus: 'transcribing',
    });
    sessionUpdateManyMock.mockResolvedValueOnce({ count: 0 }); // 抢不到 → 已在跑

    const res = await POST(makeReq(validBody()), { params });

    expect(res.status).toBe(409);
    expect(initAsyncUploadMock).not.toHaveBeenCalled();
    // 预留已发生，必须在 finally 释放（避免额度泄漏）
    expect(releaseTranscriptionMinutesMock).toHaveBeenCalledTimes(1);
  });

  it('未授权 → 401，不触碰配额', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);

    const res = await POST(makeReq(validBody()), { params });

    expect(res.status).toBe(401);
    expect(reserveTranscriptionMinutesMock).not.toHaveBeenCalled();
  });

  it('非本人 session → 403，不预留', async () => {
    sessionFindUniqueMock.mockResolvedValueOnce({ id: 's-1', userId: 'someone-else' });

    const res = await POST(makeReq(validBody()), { params });

    expect(res.status).toBe(403);
    expect(reserveTranscriptionMinutesMock).not.toHaveBeenCalled();
  });

  it('非 audio/video MIME → 400，不预留', async () => {
    const res = await POST(
      makeReq(validBody({ originalMimeType: 'application/zip' })),
      { params }
    );

    expect(res.status).toBe(400);
    expect(reserveTranscriptionMinutesMock).not.toHaveBeenCalled();
  });
});
