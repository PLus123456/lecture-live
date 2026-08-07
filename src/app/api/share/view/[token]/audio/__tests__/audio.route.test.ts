/**
 * P4-3：分享音频路由的两条独立问题。
 *  ① 限流 key 排在 sanitizeToken 之前 → /ABC123、/A!B!C!1!2!3、/~ABC123 命中同一条 ShareLink
 *     却各占一个桶，桶数无限，而这是本公开未认证端点的唯一限流；
 *  ② Cloudreve 对不可满足 Range 回 416 被当成「流式失败」，退到 loadSessionAudioArtifact
 *     把整段录音读进内存之后才返回 416。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  enforceRateLimitMock,
  shareLinkFindUniqueMock,
  loadSessionAudioArtifactMock,
  resolveSessionAudioLocationMock,
  openLocalAudioRangeStreamMock,
  openDownloadStreamMock,
  cloudreveCreateMock,
  RangeError416,
} = vi.hoisted(() => ({
  enforceRateLimitMock: vi.fn(),
  shareLinkFindUniqueMock: vi.fn(),
  loadSessionAudioArtifactMock: vi.fn(),
  resolveSessionAudioLocationMock: vi.fn(),
  openLocalAudioRangeStreamMock: vi.fn(),
  openDownloadStreamMock: vi.fn(),
  cloudreveCreateMock: vi.fn(),
  RangeError416: class CloudreveRangeNotSatisfiableError extends Error {
    contentRange: string | null;
    constructor(contentRange: string | null) {
      super('range');
      this.contentRange = contentRange;
    }
  },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { shareLink: { findUnique: shareLinkFindUniqueMock } },
}));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/sessionPersistence', () => ({
  loadSessionAudioArtifact: loadSessionAudioArtifactMock,
  resolveSessionAudioLocation: resolveSessionAudioLocationMock,
  openLocalAudioRangeStream: openLocalAudioRangeStreamMock,
}));
vi.mock('@/lib/storage/cloudreve', () => ({
  CloudreveStorage: { create: cloudreveCreateMock },
  CloudreveRangeNotSatisfiableError: RangeError416,
}));

import { GET } from '../route';

const session = {
  id: 'sess-1',
  userId: 'user-1',
  status: 'COMPLETED',
  recordingPath: 'cloudreve:recordings/user-1/a.webm',
  transcriptPath: null,
  summaryPath: null,
  enhancedAudioPath: null,
};

function mkReq(range?: string) {
  return new Request('http://localhost/api/share/view/ABC123/audio', {
    headers: range ? { range } : {},
  });
}

describe('GET /api/share/view/[token]/audio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceRateLimitMock.mockResolvedValue(null);
    shareLinkFindUniqueMock.mockResolvedValue({ expiresAt: null, session });
    cloudreveCreateMock.mockResolvedValue({ openDownloadStream: openDownloadStreamMock });
    resolveSessionAudioLocationMock.mockResolvedValue({
      kind: 'cloudreve',
      remotePath: 'recordings/user-1/a.webm',
      userId: 'user-1',
      contentType: 'audio/webm',
    });
  });

  it('P4-3：限流 key 用净化后的 token —— 加噪声不换桶', async () => {
    const noisy = new Request('http://localhost/api/share/view/x/audio');
    openDownloadStreamMock.mockResolvedValue(
      new Response('bytes', { status: 200, headers: { 'content-length': '5' } })
    );

    await GET(noisy, { params: Promise.resolve({ token: 'A!B!C!1!2!3' }) });
    await GET(mkReq(), { params: Promise.resolve({ token: '~ABC123' }) });
    await GET(mkReq(), { params: Promise.resolve({ token: 'ABC123' }) });

    const keys = enforceRateLimitMock.mock.calls.map((call) => call[1].key);
    // 三次请求命中同一条 ShareLink（净化后同为 ABC123），必须共用同一个桶。
    expect(new Set(keys)).toEqual(new Set(['share-audio:ABC123']));
  });

  it('P4-3：净化失败（全非法字符）也要过一道限流再 400', async () => {
    const res = await GET(mkReq(), { params: Promise.resolve({ token: '!!!!' }) });
    expect(res.status).toBe(400);
    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'share:view:audio:invalid' })
    );
  });

  it('P4-3：上游 416 直接回 416，绝不落进整文件缓冲回退', async () => {
    openDownloadStreamMock.mockRejectedValue(new RangeError416('bytes */1024'));

    const res = await GET(mkReq('bytes=99999999-'), {
      params: Promise.resolve({ token: 'ABC123' }),
    });

    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */1024');
    // 关键断言：不得为了回一个 416 而把整段录音读进内存。
    expect(loadSessionAudioArtifactMock).not.toHaveBeenCalled();
  });

  it('非 416 的流式失败仍回退到缓冲读取（保留旧候选回退语义）', async () => {
    openDownloadStreamMock.mockRejectedValue(new Error('node down'));
    loadSessionAudioArtifactMock.mockResolvedValue({
      data: Buffer.from('audio-bytes'),
      contentType: 'audio/webm',
    });

    const res = await GET(mkReq(), { params: Promise.resolve({ token: 'ABC123' }) });
    expect(res.status).toBe(200);
    expect(loadSessionAudioArtifactMock).toHaveBeenCalledTimes(1);
  });
});
