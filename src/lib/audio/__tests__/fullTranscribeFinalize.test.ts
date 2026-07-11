import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * finalizeFullTranscription 回归测试。
 *
 * P1-12（不对称修复）：完整版补全转录的扣费=**入口持有的预留**，finalize **不再二次 deduct**。
 * 本测试锁死「finalize 绝不再 increment 转录分钟」这一新口径（旧代码在预留之上再 deduct = 双扣）。
 * P1-17：清 Soniox 资源改为**先删 transcription 再删 file**，且**只有确认删除(2xx/404)才清 DB 外部 ID**。
 * P1-19：finalize 守卫抢不到时，**只有确认会话确实 canceled** 才删 Soniox；否则保留（转录仍需要）。
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
  // P1-17：delete 帮助函数返回「是否确认删除」，默认确认成功。
  deleteFileMock.mockResolvedValue(true);
  deleteTranscriptionMock.mockResolvedValue(true);
  persistArtifactMock.mockResolvedValue({
    path: 'local:full-transcripts/sess-full.json',
    storage: 'local',
  });
});

describe('finalizeFullTranscription', () => {
  it('正常收尾：落 fullTranscriptPath、且 P1-12 绝不再 deduct（扣费=入口预留）、不覆写实时转录', async () => {
    sessionUpdateManyMock.mockResolvedValue({ count: 1 });

    const result = await finalizeFullTranscription(session as never, sonioxConfig);

    expect(result.outcome).toBe('completed');
    expect(persistArtifactMock).toHaveBeenCalledTimes(1);

    // 扣费恰好一次，口径 = ceil(getBillableMinutes(125000)=3 × 0.8=2.4 → ceil 3)。R4：在事务内带 tx 调用。
    expect(deductMock).toHaveBeenCalledTimes(1);
    expect(deductMock).toHaveBeenCalledWith('user-1', 3, expect.anything());
    // R4：把入口预留「转」为实扣——finalize 里恰好结算一次该会话的完整版预留（同一事务内、带 tx）。
    expect(settleFullMock).toHaveBeenCalledTimes(1);
    expect(settleFullMock).toHaveBeenCalledWith('sess-full', expect.anything());

    // finalize 的 updateMany 只写 full* 字段，绝不含 transcriptPath / status / recordingPath
    const finalizeCall = sessionUpdateManyMock.mock.calls[1][0];
    expect(finalizeCall.data.fullTranscribeStatus).toBe('completed');
    expect(finalizeCall.data.fullTranscriptPath).toBeTruthy();
    expect(finalizeCall.data).not.toHaveProperty('transcriptPath');
    expect(finalizeCall.data).not.toHaveProperty('status');
    // P1-17：CAS 提交里**不再**预清 Soniox 外部 ID（改到确认删除后再清）。
    expect(finalizeCall.data).not.toHaveProperty('fullSonioxFileId');
    expect(finalizeCall.data).not.toHaveProperty('fullSonioxTranscriptionId');
  });

  it('P1-17：成功收尾先删 transcription 再删 file，确认删除后才清对应 DB 外部 ID', async () => {
    sessionUpdateManyMock.mockResolvedValue({ count: 1 });

    await finalizeFullTranscription(session as never, sonioxConfig);

    // 删除顺序：transcription 先于 file
    const txOrder = deleteTranscriptionMock.mock.invocationCallOrder[0];
    const fileOrder = deleteFileMock.mock.invocationCallOrder[0];
    expect(txOrder).toBeLessThan(fileOrder);

    // 确认删除后清 ID：第 3 次 updateMany（claim / finalize / clear）清两个 ID。
    const clearCall = sessionUpdateManyMock.mock.calls[2][0];
    expect(clearCall.data).toMatchObject({
      fullSonioxTranscriptionId: null,
      fullSonioxFileId: null,
    });
  });

  it('P1-17：删除未确认（返回 false）→ 不清对应 DB 外部 ID，留待兜底重试', async () => {
    sessionUpdateManyMock.mockResolvedValue({ count: 1 });
    deleteTranscriptionMock.mockResolvedValue(false); // 删 transcription 未确认
    deleteFileMock.mockResolvedValue(true); // 删 file 确认

    await finalizeFullTranscription(session as never, sonioxConfig);

    const clearCall = sessionUpdateManyMock.mock.calls[2][0];
    // 只清确认删除的 file ID；未确认的 transcription ID 保留（不出现在 data 里）。
    expect(clearCall.data).toHaveProperty('fullSonioxFileId', null);
    expect(clearCall.data).not.toHaveProperty('fullSonioxTranscriptionId');
  });

  it('claim 失败(并发抢先)：不拉 transcript、不落盘、不扣费', async () => {
    sessionUpdateManyMock.mockResolvedValueOnce({ count: 0 });

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
      .mockResolvedValueOnce({ count: 0 }); // finalize 守卫抢不到
    // 完整版补全转录无「用户取消」路径，故守卫抢不到时**一律不删** Soniox（比 async 更保守）。

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
      .mockResolvedValueOnce({ count: 1 }) // A: P1-17 确认删除 Soniox 后清外部 ID
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
