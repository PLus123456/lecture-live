import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * loadFullTranscript 回归测试（阶段C：读取走 sessionPersistence.readArtifactFromReference，
 * 统一兼容 local: 引用与 Cloudreve 远程路径）。本测试把 readArtifactFromReference 桩成返回
 * Buffer / null，专测 loadFullTranscript 的解析 + 防御性字段归一。
 * full-transcripts category 的真实 persist/load/delete 往返在 fullTranscribeStorage.test.ts。
 */
const { readArtifactMock } = vi.hoisted(() => ({ readArtifactMock: vi.fn() }));

vi.mock('@/lib/sessionPersistence', () => ({
  persistArtifact: vi.fn(),
  readArtifactFromReference: readArtifactMock,
}));
// 隔离 prisma / 计费 / soniox 的 import 副作用（本测试只跑纯读取逻辑）
vi.mock('@/lib/prisma', () => ({ prisma: { session: { updateMany: vi.fn() } } }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: vi.fn() }));
vi.mock('@/lib/quota', () => ({ deductTranscriptionMinutes: vi.fn() }));
vi.mock('@/lib/soniox/asyncFile', () => ({
  getSonioxTranscript: vi.fn(),
  deleteSonioxFile: vi.fn(),
  deleteSonioxTranscription: vi.fn(),
}));
vi.mock('@/lib/soniox/asyncTranscriptConverter', () => ({
  convertAsyncTokensToSegments: vi.fn(),
  extractTranslationsByTokens: vi.fn(),
}));

import { loadFullTranscript } from '@/lib/audio/fullTranscribeFinalize';

const session = {
  id: 'sess-x',
  userId: 'user-1',
  fullTranscriptPath: 'local:full-transcripts/sess-x.json',
};

function buf(value: unknown): Buffer {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadFullTranscript', () => {
  it('正常读取：返回归一后的 segments/summaries/translations', async () => {
    readArtifactMock.mockResolvedValue(
      buf({
        segments: [{ id: 's0', text: 'hi' }],
        summaries: [{ summary: 'x' }],
        translations: { s0: '你好' },
      })
    );

    const bundle = await loadFullTranscript(session as never);
    expect(bundle).not.toBeNull();
    expect(bundle!.segments).toHaveLength(1);
    expect(bundle!.summaries).toHaveLength(1);
    expect(bundle!.translations).toEqual({ s0: '你好' });

    // 阶段C：读取经 readArtifactFromReference（'full-transcripts' + fullTranscriptPath 引用）
    expect(readArtifactMock).toHaveBeenCalledWith(
      session,
      'full-transcripts',
      session.fullTranscriptPath
    );
  });

  it('引用不存在（readArtifactFromReference 返回 null）：返回 null', async () => {
    readArtifactMock.mockResolvedValue(null);
    expect(await loadFullTranscript(session as never)).toBeNull();
  });

  it('JSON 损坏：返回 null', async () => {
    readArtifactMock.mockResolvedValue(buf('{ not json '));
    expect(await loadFullTranscript(session as never)).toBeNull();
  });

  it('顶层是数组（非对象 bundle）：返回 null', async () => {
    readArtifactMock.mockResolvedValue(buf('[1,2,3]'));
    expect(await loadFullTranscript(session as never)).toBeNull();
  });

  it('防御性归一：非数组 segments → []，非字符串译文被过滤', async () => {
    readArtifactMock.mockResolvedValue(
      buf({
        segments: 'oops',
        translations: { good: 'ok', bad: 123, nested: { x: 1 } },
      })
    );
    const bundle = await loadFullTranscript(session as never);
    expect(bundle!.segments).toEqual([]);
    expect(bundle!.summaries).toEqual([]);
    expect(bundle!.translations).toEqual({ good: 'ok' });
  });

  it('无 fullTranscriptPath：以 null 引用委托 readArtifactFromReference 回退候选', async () => {
    readArtifactMock.mockResolvedValue(buf({ segments: [{ id: 's0' }] }));
    const bundle = await loadFullTranscript({
      id: 'sess-x',
      userId: 'user-1',
      fullTranscriptPath: null,
    } as never);
    expect(bundle!.segments).toHaveLength(1);
    // 引用为 null → readArtifactFromReference 内部按 sessionId 约定候选回退读取
    expect(readArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sess-x' }),
      'full-transcripts',
      null
    );
  });
});
