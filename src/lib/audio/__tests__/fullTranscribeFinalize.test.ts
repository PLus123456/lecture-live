import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * finalizeFullTranscription 回归测试。
 * 覆盖：正常收尾(落 fullTranscriptPath + 扣费一次 + 不覆写实时转录)、claim 失败(不扣费)、
 * finalize 守卫失败(收尾期间被取消：不扣费、清 Soniox)。
 */
const {
  sessionUpdateManyMock,
  getSonioxTranscriptMock,
  deleteFileMock,
  deleteTranscriptionMock,
  convertMock,
  extractMock,
  deductMock,
  getSiteSettingsMock,
} = vi.hoisted(() => ({
  sessionUpdateManyMock: vi.fn(),
  getSonioxTranscriptMock: vi.fn(),
  deleteFileMock: vi.fn(),
  deleteTranscriptionMock: vi.fn(),
  convertMock: vi.fn(),
  extractMock: vi.fn(),
  deductMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  },
}));
vi.mock('@/lib/prisma', () => ({
  prisma: { session: { updateMany: sessionUpdateManyMock } },
}));
vi.mock('@/lib/soniox/asyncFile', () => ({
  getSonioxTranscript: getSonioxTranscriptMock,
  deleteSonioxFile: deleteFileMock,
  deleteSonioxTranscription: deleteTranscriptionMock,
}));
vi.mock('@/lib/soniox/asyncTranscriptConverter', () => ({
  convertAsyncTokensToSegments: convertMock,
  extractTranslationsByTokens: extractMock,
}));
vi.mock('@/lib/quota', () => ({ deductTranscriptionMinutes: deductMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
// getBillableMinutes 用真实实现（ceil(ms/60000)）锁死计费口径

import { finalizeFullTranscription } from '@/lib/audio/fullTranscribeFinalize';

const sonioxConfig = { restBaseUrl: 'https://x', apiKey: 'k' } as never;
const session = {
  id: 'sess-full',
  userId: 'user-1',
  fullSonioxFileId: 'file-1',
  fullSonioxTranscriptionId: 'tr-1',
  targetLang: 'zh',
  durationMs: 125_000, // ceil(125000/60000)=3 分钟
};

beforeEach(() => {
  vi.clearAllMocks();
  getSonioxTranscriptMock.mockResolvedValue({ tokens: [] });
  convertMock.mockReturnValue([{ id: 'seg-0' }, { id: 'seg-1' }]);
  extractMock.mockReturnValue({});
  getSiteSettingsMock.mockResolvedValue({ async_upload_billing_multiplier: 0.8 });
  deductMock.mockResolvedValue(undefined);
  deleteFileMock.mockResolvedValue(undefined);
  deleteTranscriptionMock.mockResolvedValue(undefined);
});

describe('finalizeFullTranscription', () => {
  it('正常收尾：落 fullTranscriptPath、扣费恰好一次(ceil(3×0.8)=3)、且绝不覆写实时转录', async () => {
    // claim(transcribing→finalizing) count=1；finalize(finalizing→completed) count=1
    sessionUpdateManyMock.mockResolvedValue({ count: 1 });

    const result = await finalizeFullTranscription(session as never, sonioxConfig);

    expect(result.outcome).toBe('completed');

    // 扣费恰好一次，口径 = ceil(getBillableMinutes(125000)=3 × 0.8=2.4 → ceil 3)
    expect(deductMock).toHaveBeenCalledTimes(1);
    expect(deductMock).toHaveBeenCalledWith('user-1', 3);

    // 关键：finalize 的 updateMany 只写 full* 字段，绝不含 transcriptPath / status / recordingPath
    const finalizeCall = sessionUpdateManyMock.mock.calls[1][0];
    expect(finalizeCall.data.fullTranscribeStatus).toBe('completed');
    expect(finalizeCall.data.fullTranscriptPath).toBeTruthy();
    expect(finalizeCall.data).not.toHaveProperty('transcriptPath');
    expect(finalizeCall.data).not.toHaveProperty('status');
    expect(finalizeCall.data).not.toHaveProperty('recordingPath');
    expect(finalizeCall.data).not.toHaveProperty('summaryPath');
  });

  it('claim 失败(非 transcribing / 并发抢先)：不拉 transcript、不落盘、不扣费', async () => {
    sessionUpdateManyMock.mockResolvedValueOnce({ count: 0 }); // claim 抢不到

    const result = await finalizeFullTranscription(session as never, sonioxConfig);

    expect(result.outcome).toBe('claim_lost');
    expect(getSonioxTranscriptMock).not.toHaveBeenCalled();
    expect(deductMock).not.toHaveBeenCalled();
  });

  it('finalize 守卫失败(收尾期间被取消)：不扣费，清 Soniox 资源', async () => {
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 }) // claim 成功
      .mockResolvedValueOnce({ count: 0 }); // finalize 守卫抢不到（已取消）

    const result = await finalizeFullTranscription(session as never, sonioxConfig);

    expect(result.outcome).toBe('canceled_during_finalize');
    expect(deductMock).not.toHaveBeenCalled();
    expect(deleteFileMock).toHaveBeenCalled();
    expect(deleteTranscriptionMock).toHaveBeenCalled();
  });

  it('无 fullSonioxTranscriptionId：直接 claim_lost，不动任何东西', async () => {
    const result = await finalizeFullTranscription(
      { ...session, fullSonioxTranscriptionId: null } as never,
      sonioxConfig
    );
    expect(result.outcome).toBe('claim_lost');
    expect(sessionUpdateManyMock).not.toHaveBeenCalled();
  });
});
