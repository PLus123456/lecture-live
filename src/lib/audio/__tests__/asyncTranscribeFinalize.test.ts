import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 共享 finalizeAsyncTranscription 回归测试（v3-R6）。
 *
 * 覆盖：
 *  - 抢锁成功 → 落盘 + 按 ceil(getBillableMinutes×倍率) 扣费恰好一次 + 触发后台 LLM + 清 Soniox
 *  - 抢锁失败（count!==1，并发对方已 claim）→ 不落盘、不扣费、不删 Soniox
 *  - 收尾守卫失败（finalizing 期间被 cancel）→ 不扣费、不跑 LLM，但仍清 Soniox 资源
 *  - 计费口径：getBillableMinutes 用真实实现锁死 = ceil(durationMs/60000)×倍率 再 ceil
 */

const {
  sessionUpdateManyMock,
  sessionFindUniqueMock,
  sessionTxUpdateMock,
  transactionMock,
  getSonioxTranscriptMock,
  persistMock,
  runBackgroundLLMTasksMock,
  deductMock,
  settleMock,
  getSiteSettingsMock,
  deleteSonioxFileMock,
  deleteSonioxTranscriptionMock,
  convertMock,
  extractMock,
} = vi.hoisted(() => ({
  sessionUpdateManyMock: vi.fn(),
  sessionFindUniqueMock: vi.fn(),
  sessionTxUpdateMock: vi.fn(),
  transactionMock: vi.fn(),
  getSonioxTranscriptMock: vi.fn(),
  persistMock: vi.fn(),
  runBackgroundLLMTasksMock: vi.fn(),
  deductMock: vi.fn(),
  settleMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  deleteSonioxFileMock: vi.fn(),
  deleteSonioxTranscriptionMock: vi.fn(),
  convertMock: vi.fn(),
  extractMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    session: { updateMany: sessionUpdateManyMock, findUnique: sessionFindUniqueMock },
    // B1：finalize 结算走 $transaction(deduct + release + 清预留列)。默认实现直接执行回调，
    // 传入带 session.update 的 tx（deduct/release 由 @/lib/quota mock 拦截，忽略第三参 tx）。
    $transaction: (...a: unknown[]) => transactionMock(...a),
  },
}));

vi.mock('@/lib/soniox/asyncFile', () => ({
  getSonioxTranscript: getSonioxTranscriptMock,
  deleteSonioxFile: deleteSonioxFileMock,
  deleteSonioxTranscription: deleteSonioxTranscriptionMock,
}));

vi.mock('@/lib/soniox/asyncTranscriptConverter', () => ({
  convertAsyncTokensToSegments: convertMock,
  extractTranslationsByTokens: extractMock,
}));

vi.mock('@/lib/sessionPersistence', () => ({
  persistSessionTranscriptArtifacts: persistMock,
}));

vi.mock('@/lib/sessionFinalization', () => ({
  runBackgroundLLMTasks: runBackgroundLLMTasksMock,
}));

vi.mock('@/lib/quota', () => ({
  deductTranscriptionMinutes: deductMock,
  settleAsyncReservation: settleMock,
}));

vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: getSiteSettingsMock,
}));

// getBillableMinutes 用真实实现锁死计费口径（不 mock @/lib/billing）
import { finalizeAsyncTranscription } from '@/lib/audio/asyncTranscribeFinalize';
import type { SonioxRuntimeConfig } from '@/lib/soniox/env';

const CONFIG = {} as SonioxRuntimeConfig;

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    userId: 'u1',
    sonioxFileId: 'file-1',
    sonioxTranscriptionId: 'tx-1',
    targetLang: 'zh',
    durationMs: 600_000, // 10 分钟
    recordingPath: '/rec/s1',
    title: 'T',
    courseName: 'C',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    asyncReservedMinutes: 0,
    folderIds: ['f1', 'f2'],
    ...overrides,
  } as Parameters<typeof finalizeAsyncTranscription>[0];
}

describe('finalizeAsyncTranscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSonioxTranscriptMock.mockResolvedValue({ tokens: [{ text: 'a' }] });
    convertMock.mockReturnValue([{ id: 'seg1' }]);
    extractMock.mockReturnValue([]);
    persistMock.mockResolvedValue({
      transcript: { path: '/t/s1' },
      summary: { path: '/s/s1' },
    });
    getSiteSettingsMock.mockResolvedValue({ async_upload_billing_multiplier: 0.8 });
    deductMock.mockResolvedValue(undefined);
    settleMock.mockResolvedValue(0);
    sessionTxUpdateMock.mockResolvedValue(undefined);
    // 默认 $transaction 实现：执行回调并注入带 session.update 的 tx
    transactionMock.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ session: { update: sessionTxUpdateMock } })
    );
    // P1-17：delete 帮助函数返回「是否确认删除」，默认确认成功。
    deleteSonioxFileMock.mockResolvedValue(true);
    deleteSonioxTranscriptionMock.mockResolvedValue(true);
    sessionFindUniqueMock.mockResolvedValue({ asyncTranscribeStatus: 'canceled' });
    // 默认 updateMany 返回 count:1（claim/guard 用 mockResolvedValueOnce 覆盖前两次；
    // 第 3 次「确认删除后清 ID」的 updateMany 落到此默认值）。
    sessionUpdateManyMock.mockResolvedValue({ count: 1 });
  });

  it('抢锁成功：落盘 + 按 ceil(10×0.8)=8 分钟扣费恰好一次 + 触发后台 LLM + 清 Soniox', async () => {
    // claim → count 1；finalize 守卫 → count 1
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValueOnce({ count: 1 }); // finalize guard

    const result = await finalizeAsyncTranscription(makeSession(), CONFIG, {
      allowClaimFrom: ['transcribing'],
    });

    expect(result).toEqual({
      outcome: 'completed',
      transcriptPath: '/t/s1',
      summaryPath: '/s/s1',
      segmentCount: 1,
    });

    // claim WHERE asyncTranscribeStatus IN ['transcribing'] → 'finalizing'
    expect(sessionUpdateManyMock).toHaveBeenNthCalledWith(1, {
      where: { id: 's1', asyncTranscribeStatus: { in: ['transcribing'] } },
      data: { asyncTranscribeStatus: 'finalizing' },
    });
    // finalize 守卫 WHERE asyncTranscribeStatus='finalizing' → 'completed'
    // P1-17：CAS 提交里**不再**预清 Soniox 外部 ID（改到确认删除后再清）。
    const guardCall = sessionUpdateManyMock.mock.calls[1][0];
    expect(guardCall.where).toEqual({ id: 's1', asyncTranscribeStatus: 'finalizing' });
    expect(guardCall.data).toMatchObject({
      asyncTranscribeStatus: 'completed',
      status: 'COMPLETED',
    });
    expect(guardCall.data).not.toHaveProperty('sonioxFileId');
    expect(guardCall.data).not.toHaveProperty('sonioxTranscriptionId');

    // 计费恰好一次，口径 = ceil(ceil(600000/60000) × 0.8) = ceil(8) = 8（第三参为事务 tx）
    expect(deductMock).toHaveBeenCalledTimes(1);
    expect(deductMock).toHaveBeenCalledWith('u1', 8, expect.anything());

    expect(runBackgroundLLMTasksMock).toHaveBeenCalledTimes(1);
    // P1-17：先删 transcription 再删 file，确认删除后清对应 DB 外部 ID（第 3 次 updateMany）。
    expect(deleteSonioxTranscriptionMock).toHaveBeenCalledWith(CONFIG, 'tx-1');
    expect(deleteSonioxFileMock).toHaveBeenCalledWith(CONFIG, 'file-1');
    expect(
      deleteSonioxTranscriptionMock.mock.invocationCallOrder[0]
    ).toBeLessThan(deleteSonioxFileMock.mock.invocationCallOrder[0]);
    const clearCall = sessionUpdateManyMock.mock.calls[2][0];
    expect(clearCall.data).toMatchObject({
      sonioxTranscriptionId: null,
      sonioxFileId: null,
    });
  });

  it('抢锁失败（并发对方已 claim，count!==1）：不落盘、不扣费、不删 Soniox', async () => {
    sessionUpdateManyMock.mockResolvedValueOnce({ count: 0 }); // claim 抢不到

    const result = await finalizeAsyncTranscription(makeSession(), CONFIG, {
      allowClaimFrom: ['transcribing'],
    });

    expect(result).toEqual({ outcome: 'claim_lost' });
    expect(getSonioxTranscriptMock).not.toHaveBeenCalled();
    expect(persistMock).not.toHaveBeenCalled();
    expect(deductMock).not.toHaveBeenCalled();
    expect(runBackgroundLLMTasksMock).not.toHaveBeenCalled();
    expect(deleteSonioxFileMock).not.toHaveBeenCalled();
    expect(deleteSonioxTranscriptionMock).not.toHaveBeenCalled();
  });

  it('收尾守卫失败 + 确认已 canceled：不扣费、不跑 LLM，但清 Soniox 资源（先 transcription 后 file）', async () => {
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 }) // claim 抢到
      .mockResolvedValueOnce({ count: 0 }); // finalize 守卫失败（已被 cancel）
    // P1-19：读到确实 canceled 才删 Soniox。
    sessionFindUniqueMock.mockResolvedValue({ asyncTranscribeStatus: 'canceled' });

    const result = await finalizeAsyncTranscription(makeSession(), CONFIG, {
      allowClaimFrom: ['transcribing'],
    });

    expect(result).toEqual({ outcome: 'canceled_during_finalize' });
    expect(deductMock).not.toHaveBeenCalled();
    expect(runBackgroundLLMTasksMock).not.toHaveBeenCalled();
    // 确认取消 → 清资源（避免 Soniox 泄漏），且 transcription 先于 file。
    expect(deleteSonioxTranscriptionMock).toHaveBeenCalledWith(CONFIG, 'tx-1');
    expect(deleteSonioxFileMock).toHaveBeenCalledWith(CONFIG, 'file-1');
    expect(
      deleteSonioxTranscriptionMock.mock.invocationCallOrder[0]
    ).toBeLessThan(deleteSonioxFileMock.mock.invocationCallOrder[0]);
  });

  it('onCompleted 钩子在 finalize 守卫成功后、扣费前调用', async () => {
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const order: string[] = [];
    deductMock.mockImplementation(async () => {
      order.push('deduct');
    });
    const onCompleted = vi.fn(async () => {
      order.push('onCompleted');
    });

    await finalizeAsyncTranscription(makeSession(), CONFIG, {
      allowClaimFrom: ['transcribing'],
      onCompleted,
    });

    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['onCompleted', 'deduct']);
  });

  it('拉 transcript 抛错：不吞异常（交调用方判定瞬时/永久），claim 已抢到但未扣费', async () => {
    sessionUpdateManyMock.mockResolvedValueOnce({ count: 1 }); // claim
    const err = new Error('Soniox get transcript failed: HTTP 503');
    getSonioxTranscriptMock.mockRejectedValueOnce(err);

    await expect(
      finalizeAsyncTranscription(makeSession(), CONFIG, {
        allowClaimFrom: ['transcribing'],
      })
    ).rejects.toThrow('HTTP 503');

    expect(persistMock).not.toHaveBeenCalled();
    expect(deductMock).not.toHaveBeenCalled();
  });

  it('回收口径：allowClaimFrom=[transcribing,finalizing] 时 claim WHERE 含两态；finalize 守卫仍是单次扣费闸门', async () => {
    // 模拟回收接管一个残留 finalizing 会话：claim 命中（IN 两态），finalize 守卫命中 → 扣费一次
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 }) // claim（WHERE IN [transcribing, finalizing]）
      .mockResolvedValueOnce({ count: 1 }); // finalize 守卫（WHERE ='finalizing'）

    const result = await finalizeAsyncTranscription(makeSession(), CONFIG, {
      allowClaimFrom: ['transcribing', 'finalizing'],
    });

    expect(result.outcome).toBe('completed');
    expect(sessionUpdateManyMock).toHaveBeenNthCalledWith(1, {
      where: {
        id: 's1',
        asyncTranscribeStatus: { in: ['transcribing', 'finalizing'] },
      },
      data: { asyncTranscribeStatus: 'finalizing' },
    });
    // finalize 守卫恒为 WHERE ='finalizing'（与 allowClaimFrom 无关），保证双方最终只一个扣费
    expect(sessionUpdateManyMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 's1', asyncTranscribeStatus: 'finalizing' },
      })
    );
    expect(deductMock).toHaveBeenCalledTimes(1);
    expect(deductMock).toHaveBeenCalledWith('u1', 8, expect.anything());
  });

  it('B1 结算：同一事务内 deduct 实扣(8) + settleAsyncReservation 原子转/清入口预留', async () => {
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValueOnce({ count: 1 }); // finalize 守卫

    await finalizeAsyncTranscription(makeSession(), CONFIG, {
      allowClaimFrom: ['transcribing'],
    });

    // deduct 实扣 8（ceil(10×0.8)）+ settleAsyncReservation(sessionId, tx)：读当前列并原子释放，
    // 二者同一事务 tx。预留的具体释放/清列逻辑在 settleAsyncReservation 内（其自有单测）。
    expect(deductMock).toHaveBeenCalledTimes(1);
    expect(deductMock).toHaveBeenCalledWith('u1', 8, expect.anything());
    expect(settleMock).toHaveBeenCalledTimes(1);
    expect(settleMock).toHaveBeenCalledWith('s1', expect.anything());
  });

  it('P1-19：守卫失败但会话未取消（并发 revert/另一方抢先）→ **绝不删 Soniox**（否则销毁仍需要的转录）', async () => {
    // 两个路径都进了 finalize 体，但守卫只放行一个：本次 count=0。此时状态并非 canceled——
    // 可能是并发 finalizer 的失败回退把状态改回 transcribing（转录仍需要）。旧代码在守卫失败时
    // 无条件删 Soniox file+transcription，会让后续 salvage getSoniox 404、会话永久卡死（回归红线）。
    sessionUpdateManyMock
      .mockResolvedValueOnce({ count: 1 }) // claim 命中
      .mockResolvedValueOnce({ count: 0 }); // finalize 守卫 —— 对方抢先/被回退
    sessionFindUniqueMock.mockResolvedValue({ asyncTranscribeStatus: 'transcribing' });

    const result = await finalizeAsyncTranscription(makeSession(), CONFIG, {
      allowClaimFrom: ['transcribing', 'finalizing'],
    });

    expect(result.outcome).toBe('canceled_during_finalize');
    expect(deductMock).not.toHaveBeenCalled();
    expect(runBackgroundLLMTasksMock).not.toHaveBeenCalled();
    // ▶ 负向断言（P1-19）：未确认 canceled → 一律不删 Soniox 资源。
    expect(deleteSonioxTranscriptionMock).not.toHaveBeenCalled();
    expect(deleteSonioxFileMock).not.toHaveBeenCalled();
  });
});
