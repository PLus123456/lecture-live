import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * finalizeFullTranscription 回归测试。
 * 覆盖：正常收尾(落 fullTranscriptPath + 扣费一次 + 不覆写实时转录)、claim 失败(不扣费)、
 * finalize 守卫失败(收尾期间被取消：不扣费、清 Soniox)。
 */
const {
  sessionUpdateManyMock,
  transactionMock,
  getSonioxTranscriptMock,
  deleteFileMock,
  deleteTranscriptionMock,
  convertMock,
  extractMock,
  deductMock,
  settleFullMock,
  getSiteSettingsMock,
  persistArtifactMock,
} = vi.hoisted(() => ({
  sessionUpdateManyMock: vi.fn(),
  transactionMock: vi.fn(),
  getSonioxTranscriptMock: vi.fn(),
  deleteFileMock: vi.fn(),
  deleteTranscriptionMock: vi.fn(),
  convertMock: vi.fn(),
  extractMock: vi.fn(),
  deductMock: vi.fn(),
  settleFullMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  persistArtifactMock: vi.fn(),
}));

// 阶段C：落盘走 sessionPersistence 的 persistArtifact（'full-transcripts' category）。
vi.mock('@/lib/sessionPersistence', () => ({
  persistArtifact: persistArtifactMock,
  readArtifactFromReference: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { updateMany: sessionUpdateManyMock },
    // R4：计费块把 deduct + settleFullReservation 包进 $transaction。桩为「立即执行回调并传入哑 tx」，
    // 回调里的 deduct / settle 都是本文件的模块级 mock（不依赖 tx 对象的具体方法），故 tx 可为 {}。
    $transaction: (...a: unknown[]) => transactionMock(...a),
  },
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
vi.mock('@/lib/quota', () => ({
  deductTranscriptionMinutes: deductMock,
  settleFullReservation: settleFullMock,
}));
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
  settleFullMock.mockResolvedValue(0);
  // $transaction 桩：立即执行回调并传入哑 tx（{}）。
  transactionMock.mockImplementation(
    async (run: (tx: unknown) => Promise<unknown>) => run({})
  );
  deleteFileMock.mockResolvedValue(undefined);
  deleteTranscriptionMock.mockResolvedValue(undefined);
  persistArtifactMock.mockResolvedValue({
    path: 'local:full-transcripts/sess-full.json',
    storage: 'local',
  });
});

describe('finalizeFullTranscription', () => {
  it('正常收尾：落 fullTranscriptPath、扣费恰好一次(ceil(3×0.8)=3)、且绝不覆写实时转录', async () => {
    // claim(transcribing→finalizing) count=1；finalize(finalizing→completed) count=1
    sessionUpdateManyMock.mockResolvedValue({ count: 1 });

    const result = await finalizeFullTranscription(session as never, sonioxConfig);

    expect(result.outcome).toBe('completed');

    // 阶段C：落盘走 sessionPersistence.persistArtifact('full-transcripts')，传 session（含 userId）
    expect(persistArtifactMock).toHaveBeenCalledTimes(1);
    expect(persistArtifactMock).toHaveBeenCalledWith(
      session,
      'full-transcripts',
      expect.any(String)
    );

    // 扣费恰好一次，口径 = ceil(getBillableMinutes(125000)=3 × 0.8=2.4 → ceil 3)。R4：在事务内带 tx 调用。
    expect(deductMock).toHaveBeenCalledTimes(1);
    expect(deductMock).toHaveBeenCalledWith('user-1', 3, expect.anything());
    // R4：把入口预留「转」为实扣——finalize 里恰好结算一次该会话的完整版预留（同一事务内、带 tx）。
    expect(settleFullMock).toHaveBeenCalledTimes(1);
    expect(settleFullMock).toHaveBeenCalledWith('sess-full', expect.anything());

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
    // 未进计费块 → 预留不结算（留待重试/回收）。
    expect(settleFullMock).not.toHaveBeenCalled();
  });

  it('finalize 守卫失败(收尾期间状态被改)：不扣费，且**绝不删 Soniox 资源**(留待重新 salvage)', async () => {
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 }) // claim 成功
      .mockResolvedValueOnce({ count: 0 }); // finalize 守卫抢不到（状态已非 finalizing）

    const result = await finalizeFullTranscription(session as never, sonioxConfig);

    expect(result.outcome).toBe('canceled_during_finalize');
    expect(deductMock).not.toHaveBeenCalled();
    // 守卫抢不到 → 不进计费块 → 不结算预留（该会话预留留待删会话 inline / cron 兜底释放）。
    expect(settleFullMock).not.toHaveBeenCalled();
    // 关键回归：守卫抢不到时不能删 Soniox —— 否则「前端 poll 盲目回退 finalizing→transcribing」
    // 撞上并发 finalize 时会销毁仍需要的转录、致会话永久卡死。转录保留供下一轮 salvage。
    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(deleteTranscriptionMock).not.toHaveBeenCalled();
  });

  it('并发两路径（前端 poll + cron 回收）：claim 互斥 → 扣费恰好一次、绝不双扣', async () => {
    // 路径 A（先到者，如 cron 回收）：claim transcribing→finalizing (1) + finalize 守卫 (1) → 收尾扣费。
    // 路径 B（后到者，如前端 poll）：claim 抢不到 (0) → claim_lost，不拉 transcript、不扣费。
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 }) // A: claim 成功
      .mockResolvedValueOnce({ count: 1 }) // A: finalize 守卫成功
      .mockResolvedValueOnce({ count: 0 }); // B: claim 抢不到（A 已在收尾/已完成）

    const a = await finalizeFullTranscription(session as never, sonioxConfig);
    const b = await finalizeFullTranscription(session as never, sonioxConfig);

    expect(a.outcome).toBe('completed');
    expect(b.outcome).toBe('claim_lost');
    // 两路径共扣费恰好一次（幂等由两道原子 claim 保证）；R4：在事务内带 tx 调用。
    expect(deductMock).toHaveBeenCalledTimes(1);
    expect(deductMock).toHaveBeenCalledWith('user-1', 3, expect.anything());
    // 且预留只结算一次（对应扣费恰一次）。
    expect(settleFullMock).toHaveBeenCalledTimes(1);
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
