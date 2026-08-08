import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMultipartRequest, readJson } from '../../../../../../../../../tests/utils/http';

const {
  verifyAuthMock,
  sessionFindUniqueMock,
  persistRecordingDraftChunkMock,
  getRecordingDraftManifestSummaryMock,
  getRecordingDraftUsageMock,
  checkQuotaMock,
  enforceRateLimitMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  persistRecordingDraftChunkMock: vi.fn(),
  getRecordingDraftManifestSummaryMock: vi.fn(),
  getRecordingDraftUsageMock: vi.fn(),
  checkQuotaMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: verifyAuthMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: {
      findUnique: sessionFindUniqueMock,
    },
  },
}));

const { FakeTooLargeError } = vi.hoisted(() => ({
  FakeTooLargeError: class FakeTooLargeError extends Error {
    totalBytes = 1;
    limitBytes = 1;
  },
}));

vi.mock('@/lib/recordingDraftPersistence', () => ({
  persistRecordingDraftChunk: persistRecordingDraftChunkMock,
  getRecordingDraftManifestSummary: getRecordingDraftManifestSummaryMock,
  getRecordingDraftUsage: getRecordingDraftUsageMock,
  MAX_DRAFT_TOTAL_BYTES: 512 * 1024 * 1024,
  // instanceof 判定用的错误类（route 的 catch 分支引用）；测试路径不触发，占位即可。
  RecordingDraftChunkConflictError: class RecordingDraftChunkConflictError extends Error {
    seq: number;
    constructor(seq: number) {
      super('conflict');
      this.seq = seq;
    }
  },
  RecordingDraftSealedError: class RecordingDraftSealedError extends Error {},
  RecordingDraftTooLargeError: FakeTooLargeError,
}));

vi.mock('@/lib/quota', () => ({
  checkQuota: checkQuotaMock,
}));

vi.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: enforceRateLimitMock,
}));

import { POST, GET } from '../route';

const params = Promise.resolve({ id: 'sess-1' });

function mkRequest(seq: string) {
  return createMultipartRequest(
    'http://localhost/api/sessions/sess-1/audio/draft/chunks',
    { seq, mimeType: 'audio/webm' },
    {
      fieldName: 'file',
      fileName: 'chunk.webm',
      contents: 'chunk-bytes',
      type: 'audio/webm',
    }
  );
}

describe('POST /api/sessions/[id]/audio/draft/chunks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    sessionFindUniqueMock.mockResolvedValue({
      id: 'sess-1',
      userId: 'user-1',
      status: 'RECORDING',
    });
    checkQuotaMock.mockResolvedValue(true);
    enforceRateLimitMock.mockResolvedValue(null);
    // 默认：草稿已存在且不到复查点 —— 只有「首片」与周期复查才该触发配额校验。
    getRecordingDraftUsageMock.mockResolvedValue({
      exists: true,
      chunkCount: 5,
      totalBytes: 1024,
    });
    persistRecordingDraftChunkMock.mockResolvedValue({
      idempotent: false,
      chunkCount: 1,
      maxSeq: 0,
    });
  });

  it('P1-6：seq 超过上限返回明确 413（不再被通用 catch 变成 500 触发无限重试）', async () => {
    const res = await POST(mkRequest('50000'), { params });
    expect(res.status).toBe(413);
    const body = await readJson<{ limitExceeded?: boolean; maxChunks?: number }>(res);
    expect(body.limitExceeded).toBe(true);
    expect(body.maxChunks).toBe(50_000);
    // 超限直接短路，不落盘。
    expect(persistRecordingDraftChunkMock).not.toHaveBeenCalled();
  });

  it('P1-13：录音开始（seq 0）存储配额超限时返回 402 且不落盘', async () => {
    checkQuotaMock.mockResolvedValue(false);
    const res = await POST(mkRequest('0'), { params });
    expect(res.status).toBe(402);
    const body = await readJson<{ quota?: string }>(res);
    expect(body.quota).toBe('storage_hours');
    expect(checkQuotaMock).toHaveBeenCalledWith('user-1', 'storage_hours');
    // 旧代码此入口从不校验存储配额，会直接落盘；新代码在超限时短路。
    expect(persistRecordingDraftChunkMock).not.toHaveBeenCalled();
  });

  it('配额内的 seq 0 正常落盘并回传维护式 chunkCount', async () => {
    const res = await POST(mkRequest('0'), { params });
    expect(res.status).toBe(200);
    const body = await readJson<{ chunkCount?: number; idempotent?: boolean }>(res);
    expect(body.chunkCount).toBe(1);
    expect(body.idempotent).toBe(false);
    expect(persistRecordingDraftChunkMock).toHaveBeenCalledTimes(1);
  });

  it('续录分片（seq>0）不重复做存储配额校验（避免每片 SUM 聚合）', async () => {
    const res = await POST(mkRequest('5'), { params });
    expect(res.status).toBe(200);
    expect(checkQuotaMock).not.toHaveBeenCalled();
  });

  it('P4-1：从 seq=1 起传（本会话第一片）同样要过存储配额闸，不再被绕过', async () => {
    // seq 不要求连续：旧代码只在 seq===0 查配额，攻击者从 seq=1 开始即完全跳过唯一的闸。
    getRecordingDraftUsageMock.mockResolvedValue({
      exists: false,
      chunkCount: 0,
      totalBytes: 0,
    });
    checkQuotaMock.mockResolvedValue(false);

    const res = await POST(mkRequest('1'), { params });
    expect(res.status).toBe(402);
    expect(checkQuotaMock).toHaveBeenCalledWith('user-1', 'storage_hours');
    expect(persistRecordingDraftChunkMock).not.toHaveBeenCalled();
  });

  it('P4-1：长会话每 200 片复查一次配额（开录时不超额、录着录着超额也会被拦）', async () => {
    getRecordingDraftUsageMock.mockResolvedValue({
      exists: true,
      chunkCount: 400,
      totalBytes: 1024,
    });
    checkQuotaMock.mockResolvedValue(false);

    const res = await POST(mkRequest('400'), { params });
    expect(res.status).toBe(402);
    expect(persistRecordingDraftChunkMock).not.toHaveBeenCalled();
  });

  it('P4-1：草稿字节总量触顶返回 413（limitExceeded）而非 500', async () => {
    persistRecordingDraftChunkMock.mockRejectedValue(new FakeTooLargeError('too large'));
    const res = await POST(mkRequest('9'), { params });
    expect(res.status).toBe(413);
    const body = await readJson<{ limitExceeded?: boolean; maxTotalBytes?: number }>(res);
    expect(body.limitExceeded).toBe(true);
    expect(body.maxTotalBytes).toBe(512 * 1024 * 1024);
  });

  it('P4-1：限流命中时直接返回 429，且不落盘、不查库', async () => {
    enforceRateLimitMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 })
    );
    const res = await POST(mkRequest('3'), { params });
    expect(res.status).toBe(429);
    expect(sessionFindUniqueMock).not.toHaveBeenCalled();
    expect(persistRecordingDraftChunkMock).not.toHaveBeenCalled();
    // 分桶必须按 user+session，不能落到 IP（TRUSTED_PROXY 缺省时 IP 恒为 'unknown' = 全站一个桶）。
    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'user:user-1:session:sess-1' })
    );
  });
});

// P0-4 契约1 —— 客户端 useSoniox.negotiateStartSeq 冷启动/续录前 GET 本端点，读 `nextSeq`
// 作为归档起始 seq。这里锁定服务端 GET 的**确切 wire 形状**与客户端读取字段一字不差
// （字段名 / 类型 / 值），杜绝任一侧独立改名（如 nextSeq→next_seq）而单测各自 mock 察觉不到。
describe('GET /api/sessions/[id]/audio/draft/chunks（negotiateStartSeq 契约）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    sessionFindUniqueMock.mockResolvedValue({
      id: 'sess-1',
      userId: 'user-1',
      status: 'RECORDING',
    });
  });

  const mkGet = () =>
    new Request('http://localhost/api/sessions/sess-1/audio/draft/chunks');

  it('返回 { maxSeq, nextSeq, revision, sealed }，字段名与客户端读取完全一致', async () => {
    getRecordingDraftManifestSummaryMock.mockResolvedValue({
      maxSeq: 4,
      nextSeq: 5,
      revision: 1234,
      sealed: false,
    });

    const res = await GET(mkGet(), { params });
    expect(res.status).toBe(200);

    const body = await readJson<{
      maxSeq?: number;
      nextSeq?: number;
      revision?: number;
      sealed?: boolean;
    }>(res);

    // 客户端 negotiateStartSeq 仅当 `typeof data.nextSeq === 'number' && data.nextSeq >= 0`
    // 才采用；这里断言该字段存在、为 number、且等于服务端 maxSeq+1。
    expect(typeof body.nextSeq).toBe('number');
    expect(body.nextSeq).toBe(5);
    // 完整 wire 形状（服务端 getRecordingDraftManifestSummary 的四字段）原样透传到响应。
    expect(body).toEqual({ maxSeq: 4, nextSeq: 5, revision: 1234, sealed: false });
    expect(getRecordingDraftManifestSummaryMock).toHaveBeenCalledTimes(1);
  });

  it('无草稿：maxSeq=-1 / nextSeq=0 —— 客户端据此从 seq 0 起录（全新会话）', async () => {
    getRecordingDraftManifestSummaryMock.mockResolvedValue({
      maxSeq: -1,
      nextSeq: 0,
      revision: 0,
      sealed: false,
    });

    const res = await GET(mkGet(), { params });
    expect(res.status).toBe(200);
    const body = await readJson<{ nextSeq?: number }>(res);
    // nextSeq=0 满足客户端 `>= 0` 判定 → Math.floor(0)=0，归档从 0 开始。
    expect(body.nextSeq).toBe(0);
  });
});
