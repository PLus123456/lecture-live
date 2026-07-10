import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * loadFullTranscript 回归测试：读 fullTranscriptPath 落盘的 JSON bundle，
 * 覆盖正常读取、文件缺失、JSON 损坏、非对象、防御性字段归一。
 */
const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));

vi.mock('fs/promises', () => ({
  default: {
    readFile: readFileMock,
    // 落盘用（persist 路径），本测试不触发，占位避免 undefined
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  },
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
  fullTranscriptPath: 'local:full-transcripts/sess-x.json',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadFullTranscript', () => {
  it('正常读取：返回归一后的 segments/summaries/translations', async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
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
  });

  it('文件缺失（readFile 抛错）：返回 null', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await loadFullTranscript(session as never)).toBeNull();
  });

  it('JSON 损坏：返回 null', async () => {
    readFileMock.mockResolvedValue('{ not json ');
    expect(await loadFullTranscript(session as never)).toBeNull();
  });

  it('顶层是数组（非对象 bundle）：返回 null', async () => {
    readFileMock.mockResolvedValue('[1,2,3]');
    expect(await loadFullTranscript(session as never)).toBeNull();
  });

  it('防御性归一：非数组 segments → []，非字符串译文被过滤', async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        segments: 'oops',
        translations: { good: 'ok', bad: 123, nested: { x: 1 } },
      })
    );
    const bundle = await loadFullTranscript(session as never);
    expect(bundle!.segments).toEqual([]);
    expect(bundle!.summaries).toEqual([]);
    expect(bundle!.translations).toEqual({ good: 'ok' });
  });

  it('无 fullTranscriptPath：按 sessionId 约定路径回退读取（文件存在则成功）', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ segments: [{ id: 's0' }] }));
    const bundle = await loadFullTranscript({ id: 'sess-x', fullTranscriptPath: null } as never);
    expect(bundle!.segments).toHaveLength(1);
    // 读取路径落在 full-transcripts 目录内
    const calledPath = String(readFileMock.mock.calls[0][0]);
    expect(calledPath).toContain('full-transcripts');
    expect(calledPath).toContain('sess-x.json');
  });
});
