import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R1-L3：Soniox /v1/usage-logs 对账 cron。核心不变量——
 *  - 回填：actualMs IS NULL 的 CAS 条件更新恰好一次（窗口重叠重拉幂等）；
 *  - 迟到补扣：曾退款（usage_refund/mint_failed）的 grant 事后冒出用量 → 按实测补扣，
 *    退款窗口不构成白嫖窗口；
 *  - 孤儿结算：过期未结且无内容实体接手的 grant——有用量转实扣、没用过退预扣；
 *  - watermark：整窗拉取成功才推进，失败下轮重试。
 */

const {
  siteFindUniqueMock,
  siteUpsertMock,
  grantUpdateManyMock,
  grantFindUniqueMock,
  grantFindManyMock,
  txGrantFindManyMock,
  grantUpdateMock,
  sessionFindUniqueMock,
  txSessionFindUniqueMock,
  interpretFindUniqueMock,
  txInterpretFindUniqueMock,
  txUserFindUniqueMock,
  transactionMock,
  deductMock,
  regionConfigMock,
  settleGrantsMock,
  logSystemEventMock,
  fetchMock,
  TX,
} = vi.hoisted(() => {
  const grantUpdateMock = vi.fn();
  const grantUpdateManyMock = vi.fn();
  const grantFindUniqueMock = vi.fn();
  // tx 侧与 prisma 侧分开两组 mock：孤儿扫描走 prisma，回填/差额补扣走 tx，断言互不串扰。
  const txGrantFindManyMock = vi.fn();
  const txSessionFindUniqueMock = vi.fn();
  const txInterpretFindUniqueMock = vi.fn();
  const txUserFindUniqueMock = vi.fn();
  return {
    siteFindUniqueMock: vi.fn(),
    siteUpsertMock: vi.fn(),
    grantUpdateManyMock,
    grantFindUniqueMock,
    grantFindManyMock: vi.fn(),
    txGrantFindManyMock,
    grantUpdateMock,
    sessionFindUniqueMock: vi.fn(),
    txSessionFindUniqueMock,
    interpretFindUniqueMock: vi.fn(),
    txInterpretFindUniqueMock,
    txUserFindUniqueMock,
    transactionMock: vi.fn(),
    deductMock: vi.fn(),
    regionConfigMock: vi.fn(),
    settleGrantsMock: vi.fn(),
    logSystemEventMock: vi.fn(),
    fetchMock: vi.fn(),
    // $transaction 注入的 tx。P5-17 后**回填 CAS 也在事务内**，故 tx 要带回填/读取的全部方法；
    // 差额补扣（P1-2）还要按实体读锚点/会话。
    TX: {
      sonioxStreamGrant: {
        update: grantUpdateMock,
        updateMany: grantUpdateManyMock,
        findUnique: grantFindUniqueMock,
        findMany: txGrantFindManyMock,
      },
      interpretSession: { findUnique: txInterpretFindUniqueMock },
      session: { findUnique: txSessionFindUniqueMock },
      // M9：interpret 分支现在要按用户角色 clamp（FREE 2h / PRO 4h），故 tx 需带 user 读取。
      user: { findUnique: txUserFindUniqueMock },
    },
  };
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: { findUnique: siteFindUniqueMock, upsert: siteUpsertMock },
    sonioxStreamGrant: {
      updateMany: grantUpdateManyMock,
      findUnique: grantFindUniqueMock,
      findMany: grantFindManyMock,
      update: grantUpdateMock,
    },
    session: { findUnique: sessionFindUniqueMock },
    interpretSession: { findUnique: interpretFindUniqueMock },
    $transaction: (...a: unknown[]) => transactionMock(...a),
  },
}));
vi.mock('@/lib/quota', () => ({ deductTranscriptionMinutes: deductMock }));
// billing 是纯函数模块，不 mock —— clamp/ceil 的真实口径正是补扣正确性的一部分。
vi.mock('@/lib/soniox/env', () => ({ getRegionConfigAsync: regionConfigMock }));
vi.mock('@/lib/soniox/streamGrant', () => ({ settleStreamGrants: settleGrantsMock }));
vi.mock('@/lib/auditLog', () => ({ logSystemEvent: logSystemEventMock }));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

import { reconcileSonioxStreamUsage } from '@/lib/soniox/usageReconciliation';

vi.stubGlobal('fetch', fetchMock);
afterAll(() => {
  vi.unstubAllGlobals();
});

const NOW = new Date('2026-07-16T12:00:00.000Z');
const WATERMARK_KEY = 'billing_soniox_usage_watermark_eu';
const EU_CONFIG = {
  region: 'eu',
  apiKey: 'k',
  restBaseUrl: 'https://api.eu.soniox.com',
  wsBaseUrl: 'wss://x',
};

interface UsageLog {
  uuid: string;
  client_reference_id?: string | null;
  input_audio_duration_ms?: number | null;
}

/** 一页 usage-logs 响应。 */
const usagePage = (logs: UsageLog[], cursor: string | null = null) => ({
  ok: true,
  status: 200,
  json: async () => ({ usage_logs: logs, next_page_cursor: cursor }),
});

/** 过期未结孤儿 grant（mintedAt 2h 前，远超 60s + 900s + 30min 宽限）。 */
const orphanGrant = (overrides: Record<string, unknown> = {}) => ({
  id: 'g9',
  userId: 'u1',
  kind: 'realtime',
  sessionId: 's9',
  interpretSessionId: null,
  reservedMinutes: 15,
  maxSessionSeconds: 900,
  mintedAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
  actualMs: 300_000,
  ...overrides,
});

beforeEach(() => {
  siteFindUniqueMock.mockReset();
  siteUpsertMock.mockReset();
  grantUpdateManyMock.mockReset();
  grantFindUniqueMock.mockReset();
  grantFindManyMock.mockReset();
  txGrantFindManyMock.mockReset();
  grantUpdateMock.mockReset();
  sessionFindUniqueMock.mockReset();
  txSessionFindUniqueMock.mockReset();
  interpretFindUniqueMock.mockReset();
  txInterpretFindUniqueMock.mockReset();
  txUserFindUniqueMock.mockReset();
  transactionMock.mockReset();
  deductMock.mockReset();
  regionConfigMock.mockReset();
  settleGrantsMock.mockReset();
  logSystemEventMock.mockReset();
  fetchMock.mockReset();

  // 只配置 eu 一个区（us/jp 未配置 → 跳过），默认返回空页。
  regionConfigMock.mockImplementation(async (region: string) =>
    region === 'eu' ? EU_CONFIG : null
  );
  fetchMock.mockResolvedValue(usagePage([]));
  siteFindUniqueMock.mockResolvedValue(null); // 无 watermark（首轮回看）
  siteUpsertMock.mockResolvedValue({});
  grantUpdateManyMock.mockResolvedValue({ count: 0 });
  grantFindUniqueMock.mockResolvedValue(null);
  grantFindManyMock.mockResolvedValue([]); // 默认无孤儿候选
  txGrantFindManyMock.mockResolvedValue([]);
  grantUpdateMock.mockResolvedValue({});
  sessionFindUniqueMock.mockResolvedValue(null);
  txSessionFindUniqueMock.mockResolvedValue(null);
  interpretFindUniqueMock.mockResolvedValue(null);
  txInterpretFindUniqueMock.mockResolvedValue(null);
  txUserFindUniqueMock.mockResolvedValue({ role: 'FREE' });
  transactionMock.mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) => cb(TX)
  );
  deductMock.mockResolvedValue({ role: 'FREE' });
  settleGrantsMock.mockResolvedValue({
    settledCount: 1,
    releasedMinutes: 15,
    actualMsTotal: 0,
  });
  logSystemEventMock.mockReturnValue(undefined);
});

describe('回填（usage-logs → grant.actualMs，CAS 恰好一次）', () => {
  it('回填成功且 finalize 扣费已覆盖实测量 → 只回填不补扣，推进 watermark', async () => {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'rt:u1:g1', input_audio_duration_ms: 20017 },
      ])
    );
    grantUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    grantFindUniqueMock.mockResolvedValueOnce({
      userId: 'u1',
      sessionId: 's1',
      interpretSessionId: null,
      settledAt: new Date('2026-07-16T11:00:00.000Z'),
      settledBy: 'session_finalize',
      maxSessionSeconds: 900,
      billedMinutes: null,
    });
    txGrantFindManyMock.mockResolvedValueOnce([
      { actualMs: 20017, maxSessionSeconds: 900, billedMinutes: null },
    ]);
    // 本场 finalize 已按 30 分钟扣过，实测 1 分钟 → 差额 0
    txSessionFindUniqueMock.mockResolvedValueOnce({
      durationMs: 30 * 60_000,
      billedMinutes: 30,
      user: { role: 'FREE' },
    });

    const stats = await reconcileSonioxStreamUsage(NOW);

    // CAS：id+userId（纵深防御）+ actualMs IS NULL 才写入
    expect(grantUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 'g1', userId: 'u1', actualMs: null },
      data: { actualMs: 20017, usageLogUuid: 'log1' },
    });
    // 差额 0 → 不扣、不改台账
    expect(deductMock).not.toHaveBeenCalled();
    expect(grantUpdateMock).not.toHaveBeenCalled();
    // 整窗成功 → watermark 推进到 now
    expect(siteUpsertMock).toHaveBeenCalledWith({
      where: { key: WATERMARK_KEY },
      create: { key: WATERMARK_KEY, value: NOW.toISOString() },
      update: { value: NOW.toISOString() },
    });
    expect(stats).toEqual({
      regionsPolled: 1,
      logsSeen: 1,
      backfilled: 1,
      lateCharged: 0,
      orphanCharged: 0,
      orphanRefunded: 0,
    });
  });

  it('P5-17：回填 CAS 在事务内 —— 事务开不起来时 CAS 根本不发生（旧实现裸 prisma 先自动提交）', async () => {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'rt:u1:g1', input_audio_duration_ms: 20017 },
      ])
    );
    transactionMock.mockRejectedValueOnce(new Error('deadlock'));

    await reconcileSonioxStreamUsage(NOW);

    // 旧实现：actualMs 已被自动提交的 updateMany 写死 → 重叠窗重拉被 CAS 挡掉，补扣永远没有第二次机会
    expect(grantUpdateManyMock).not.toHaveBeenCalled();
  });

  it('P5-17：条目处理失败 → 不推进 watermark（旧实现照推，落在重叠窗之外的条目永久丢账）', async () => {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'rt:u1:g1', input_audio_duration_ms: 20017 },
      ])
    );
    transactionMock.mockRejectedValueOnce(new Error('deadlock'));

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(siteUpsertMock).not.toHaveBeenCalled();
    expect(stats.regionsPolled).toBe(1);
    expect(stats.backfilled).toBe(0);
  });

  it('迟到补扣：曾按无用量退款（usage_refund）的 grant 冒出用量 → 事务内补扣实测分钟并改写台账', async () => {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'rt:u1:g1', input_audio_duration_ms: 20017 },
      ])
    );
    grantUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    grantFindUniqueMock.mockResolvedValueOnce({
      userId: 'u1',
      sessionId: 's1',
      interpretSessionId: null,
      settledAt: new Date('2026-07-16T10:00:00.000Z'),
      settledBy: 'usage_refund',
      maxSessionSeconds: 900,
      billedMinutes: null,
    });

    const stats = await reconcileSonioxStreamUsage(NOW);

    // ceil(20017/60000)=1 分钟（封顶 maxSessionSeconds/60=15），补扣与台账同事务
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(deductMock).toHaveBeenCalledWith('u1', 1, TX);
    expect(grantUpdateMock).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { billedMinutes: 1, settledBy: 'usage_cron' },
    });
    expect(logSystemEventMock).toHaveBeenCalledWith(
      'soniox.late_usage_charged',
      expect.stringContaining('"grantId":"g1"')
    );
    expect(stats).toEqual({
      regionsPolled: 1,
      logsSeen: 1,
      backfilled: 0,
      lateCharged: 1,
      orphanCharged: 0,
      orphanRefunded: 0,
    });
  });

  it('grant 尚未结算 → 只回填，等权威路径/孤儿扫描按刚回填的实测量结算', async () => {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'it:u1:g1', input_audio_duration_ms: 900_000 },
      ])
    );
    grantUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    grantFindUniqueMock.mockResolvedValueOnce({
      userId: 'u1',
      sessionId: null,
      interpretSessionId: 'i1',
      settledAt: null,
      settledBy: null,
      maxSessionSeconds: 900,
      billedMinutes: null,
    });

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(deductMock).not.toHaveBeenCalled();
    expect(stats.backfilled).toBe(1);
    expect(stats.lateCharged).toBe(0);
  });
});

describe('P1-2 迟到差额补扣（提前结算后继续串流的兜底）', () => {
  /** interpret grant：被 deduct 提前结算，锚点只记了 chargedMinutes 分钟。 */
  function interpretGrantSettledByDeduct(chargedMinutes: number | null) {
    grantUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    grantFindUniqueMock.mockResolvedValueOnce({
      userId: 'u1',
      sessionId: null,
      interpretSessionId: 'i1',
      settledAt: new Date('2026-07-16T11:50:00.000Z'),
      settledBy: 'interpret_deduct',
      maxSessionSeconds: 900,
      billedMinutes: null,
    });
    txInterpretFindUniqueMock.mockResolvedValueOnce({
      billedMinutes: chargedMinutes,
    });
  }

  it('interpret：/start → mint → deduct{durationMs:0} 提前结算后串满 15 分钟 → 补扣 15', async () => {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'it:u1:g1', input_audio_duration_ms: 900_000 },
      ])
    );
    interpretGrantSettledByDeduct(0);
    txGrantFindManyMock.mockResolvedValueOnce([
      { actualMs: 900_000, maxSessionSeconds: 900, billedMinutes: null },
    ]);

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(txGrantFindManyMock).toHaveBeenCalledWith({
      where: { interpretSessionId: 'i1' },
      select: { actualMs: true, maxSessionSeconds: true, billedMinutes: true },
    });
    expect(deductMock).toHaveBeenCalledWith('u1', 15, TX);
    // settledBy 保留 interpret_deduct（审计流水要看得出这场最初是谁结的）
    expect(grantUpdateMock).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { billedMinutes: 15 },
    });
    expect(stats.lateCharged).toBe(1);
  });

  it('interpret：一场多条流时按**整场**算差额，不逐 grant 重复补', async () => {
    // 锚点已扣 0；两条流各 15 分钟，其中 g0 早前已补扣 15 → 本次只该再补 15（不是 30）
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'it:u1:g1', input_audio_duration_ms: 900_000 },
      ])
    );
    interpretGrantSettledByDeduct(0);
    txGrantFindManyMock.mockResolvedValueOnce([
      { actualMs: 900_000, maxSessionSeconds: 900, billedMinutes: 15 },
      { actualMs: 900_000, maxSessionSeconds: 900, billedMinutes: null },
    ]);

    await reconcileSonioxStreamUsage(NOW);

    expect(deductMock).toHaveBeenCalledWith('u1', 15, TX);
  });

  it('interpret：deduct 已按整场足额扣过 → 差额 0，不补扣（诚实用户不被重复收）', async () => {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'it:u1:g1', input_audio_duration_ms: 900_000 },
      ])
    );
    interpretGrantSettledByDeduct(40);
    txGrantFindManyMock.mockResolvedValueOnce([
      { actualMs: 900_000, maxSessionSeconds: 900, billedMinutes: null },
    ]);

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(deductMock).not.toHaveBeenCalled();
    expect(grantUpdateMock).not.toHaveBeenCalled();
    expect(stats.lateCharged).toBe(0);
    expect(stats.backfilled).toBe(1);
  });

  it('realtime：usage-log 落在 finalize 之后（finalize 只按内容口径扣了 0）→ 按实测补扣', async () => {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'rt:u1:g1', input_audio_duration_ms: 900_000 },
      ])
    );
    grantUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    grantFindUniqueMock.mockResolvedValueOnce({
      userId: 'u1',
      sessionId: 's1',
      interpretSessionId: null,
      settledAt: new Date('2026-07-16T11:50:00.000Z'),
      settledBy: 'session_finalize',
      maxSessionSeconds: 900,
      billedMinutes: null,
    });
    txGrantFindManyMock.mockResolvedValueOnce([
      { actualMs: 900_000, maxSessionSeconds: 900, billedMinutes: null },
    ]);
    txSessionFindUniqueMock.mockResolvedValueOnce({
      durationMs: 0,
      billedMinutes: 0,
      user: { role: 'FREE' },
    });

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(deductMock).toHaveBeenCalledWith('u1', 15, TX);
    expect(stats.lateCharged).toBe(1);
  });

  it('realtime：角色时长上限（FREE 2h）是刻意保护，补扣不得绕过它', async () => {
    // 实测 3h（多条流合计），FREE clamp 到 2h=120 分钟；finalize 已按 clamp 后的 120 扣过 → 差额 0
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'rt:u1:g1', input_audio_duration_ms: 900_000 },
      ])
    );
    grantUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    grantFindUniqueMock.mockResolvedValueOnce({
      userId: 'u1',
      sessionId: 's1',
      interpretSessionId: null,
      settledAt: new Date('2026-07-16T11:50:00.000Z'),
      settledBy: 'session_finalize',
      maxSessionSeconds: 900,
      billedMinutes: null,
    });
    txGrantFindManyMock.mockResolvedValueOnce(
      Array.from({ length: 12 }, () => ({
        actualMs: 900_000,
        maxSessionSeconds: 900,
        billedMinutes: null,
      }))
    );
    txSessionFindUniqueMock.mockResolvedValueOnce({
      durationMs: 2 * 60 * 60_000,
      billedMinutes: 120,
      user: { role: 'FREE' },
    });

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(deductMock).not.toHaveBeenCalled();
    expect(stats.lateCharged).toBe(0);
  });

  it('ADMIN：deduct 短路不扣费 → grant 台账不虚记分钟', async () => {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'it:u1:g1', input_audio_duration_ms: 900_000 },
      ])
    );
    interpretGrantSettledByDeduct(0);
    txGrantFindManyMock.mockResolvedValueOnce([
      { actualMs: 900_000, maxSessionSeconds: 900, billedMinutes: null },
    ]);
    deductMock.mockResolvedValueOnce({ role: 'ADMIN' });

    await reconcileSonioxStreamUsage(NOW);

    expect(grantUpdateMock).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { billedMinutes: 0 },
    });
  });

});

describe('拉取、分页与幂等', () => {
  it('client_reference_id 非 grant 格式（旧 interpret 格式）→ 跳过，不碰 grant', async () => {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'interpret:en:zh', input_audio_duration_ms: 20017 },
      ])
    );

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(grantUpdateManyMock).not.toHaveBeenCalled();
    expect(grantFindUniqueMock).not.toHaveBeenCalled();
    expect(stats).toEqual({
      regionsPolled: 1,
      logsSeen: 1,
      backfilled: 0,
      lateCharged: 0,
      orphanCharged: 0,
      orphanRefunded: 0,
    });
  });

  it('CAS 失败且是**同一条** log 重拉（uuid 相同）→ skipped，不告警、不补扣', async () => {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'rt:u1:g1', input_audio_duration_ms: 20017 },
      ])
    );
    grantUpdateManyMock.mockResolvedValueOnce({ count: 0 });
    // L23：CAS 失败后会读一次 grant，用 usageLogUuid 区分「重叠窗重拉同一条」与
    // 「同一 grant 冒出第二条不同的 log」。uuid 相同 = 前者 = 幂等设计的正常形态。
    grantFindUniqueMock.mockResolvedValueOnce({
      usageLogUuid: 'log1',
      actualMs: 20017,
    });

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(grantUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(logSystemEventMock).not.toHaveBeenCalled();
    expect(deductMock).not.toHaveBeenCalled();
    expect(stats.backfilled).toBe(0);
    expect(stats.lateCharged).toBe(0);
    expect(stats.logsSeen).toBe(1);
  });

  it('L23：同一 grant 的第二条**不同** usage-log 被忽略时必须留痕告警（旧代码完全静默）', async () => {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log2', client_reference_id: 'rt:u1:g1', input_audio_duration_ms: 900_000 },
      ])
    );
    grantUpdateManyMock.mockResolvedValueOnce({ count: 0 });
    grantFindUniqueMock.mockResolvedValueOnce({
      usageLogUuid: 'log1',
      actualMs: 20017,
    });

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(logSystemEventMock).toHaveBeenCalledWith(
      'soniox.conflicting_usage_log',
      expect.stringContaining('log2')
    );
    // 只告警不自动补扣（Soniox 侧语义未确认前盲目补扣可能重复收费）。
    expect(deductMock).not.toHaveBeenCalled();
    expect(stats.lateCharged).toBe(0);
    // 仍算 skipped，watermark 照常推进（不是条目失败）。
    expect(siteUpsertMock).toHaveBeenCalled();
  });

  it('分页：next_page_cursor 续拉直到耗尽，第二页带 cursor 参数', async () => {
    fetchMock
      .mockResolvedValueOnce(usagePage([], 'c1'))
      .mockResolvedValueOnce(usagePage([], null));

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = String(fetchMock.mock.calls[0][0]);
    const secondUrl = String(fetchMock.mock.calls[1][0]);
    expect(firstUrl).toContain('https://api.eu.soniox.com/v1/usage-logs');
    expect(firstUrl).toContain('limit=1000');
    expect(firstUrl).not.toContain('cursor=');
    expect(secondUrl).toContain('cursor=c1');
    expect(stats.regionsPolled).toBe(1);
  });

  it('拉取失败（HTTP 非 2xx）→ 该区不推进 watermark、不计入 regionsPolled；孤儿扫描不受影响', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(siteUpsertMock).not.toHaveBeenCalled();
    expect(stats).toEqual({
      regionsPolled: 0,
      logsSeen: 0,
      backfilled: 0,
      lateCharged: 0,
      orphanCharged: 0,
      orphanRefunded: 0,
    });
    // 区域轮询失败不阻塞孤儿结算
    expect(grantFindManyMock).toHaveBeenCalledTimes(1);
  });
});

describe('孤儿 grant 结算', () => {
  it('过期未结 + session 非活跃 + 有实测用量 → settle+按实测转实扣+记台账同事务', async () => {
    grantFindManyMock.mockResolvedValueOnce([orphanGrant()]);
    sessionFindUniqueMock.mockResolvedValueOnce({ status: 'CREATED' });
    settleGrantsMock.mockResolvedValueOnce({
      settledCount: 1,
      releasedMinutes: 15,
      actualMsTotal: 300_000,
    });

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(sessionFindUniqueMock).toHaveBeenCalledWith({
      where: { id: 's9' },
      select: { status: true },
    });
    // settle（释放预扣）与扣实测同一事务
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(settleGrantsMock).toHaveBeenCalledWith({ grantId: 'g9' }, 'usage_cron', TX);
    // ceil(300000/60000)=5 分钟（封顶 15）
    expect(deductMock).toHaveBeenCalledWith('u1', 5, TX);
    expect(grantUpdateMock).toHaveBeenCalledWith({
      where: { id: 'g9' },
      data: { billedMinutes: 5 },
    });
    expect(logSystemEventMock).toHaveBeenCalledWith(
      'soniox.orphan_grant_charged',
      expect.stringContaining('"grantId":"g9"')
    );
    expect(stats.orphanCharged).toBe(1);
    expect(stats.orphanRefunded).toBe(0);
  });

  it('所属 Session 仍活跃（RECORDING）→ 留给 finalize/reclaim，跳过不结算', async () => {
    grantFindManyMock.mockResolvedValueOnce([orphanGrant()]);
    sessionFindUniqueMock.mockResolvedValueOnce({ status: 'RECORDING' });

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(settleGrantsMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(deductMock).not.toHaveBeenCalled();
    expect(stats.orphanCharged).toBe(0);
    expect(stats.orphanRefunded).toBe(0);
  });

  it('interpret grant 且锚点未结算 → 留给 interpret cron，跳过', async () => {
    grantFindManyMock.mockResolvedValueOnce([
      orphanGrant({ kind: 'interpret', sessionId: null, interpretSessionId: 'i1' }),
    ]);
    interpretFindUniqueMock.mockResolvedValueOnce({ settledAt: null });

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(interpretFindUniqueMock).toHaveBeenCalledWith({
      where: { id: 'i1' },
      select: { settledAt: true },
    });
    expect(settleGrantsMock).not.toHaveBeenCalled();
    expect(deductMock).not.toHaveBeenCalled();
    expect(stats.orphanCharged).toBe(0);
    expect(stats.orphanRefunded).toBe(0);
  });

  it('孤儿无实测用量（key 从未建连）→ 全额退预扣（settle 自开事务，不带 tx 参数）', async () => {
    grantFindManyMock.mockResolvedValueOnce([orphanGrant({ actualMs: null })]);
    sessionFindUniqueMock.mockResolvedValueOnce({ status: 'COMPLETED' });
    settleGrantsMock.mockResolvedValueOnce({
      settledCount: 1,
      releasedMinutes: 15,
      actualMsTotal: 0,
    });

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(settleGrantsMock).toHaveBeenCalledTimes(1);
    expect(settleGrantsMock).toHaveBeenCalledWith({ grantId: 'g9' }, 'usage_refund');
    expect(transactionMock).not.toHaveBeenCalled();
    expect(deductMock).not.toHaveBeenCalled();
    expect(stats.orphanCharged).toBe(0);
    expect(stats.orphanRefunded).toBe(1);
  });

  it('未过期（mintedAt 距 now < key TTL + 连接上限 + 30min 宽限）→ 可能仍在串流/等落账，跳过', async () => {
    grantFindManyMock.mockResolvedValueOnce([
      orphanGrant({ mintedAt: new Date(NOW.getTime() - 10 * 60_000) }),
    ]);

    const stats = await reconcileSonioxStreamUsage(NOW);

    // 过期判定不通过 → 连归属活跃性都不查
    expect(sessionFindUniqueMock).not.toHaveBeenCalled();
    expect(settleGrantsMock).not.toHaveBeenCalled();
    expect(deductMock).not.toHaveBeenCalled();
    expect(stats.orphanCharged).toBe(0);
    expect(stats.orphanRefunded).toBe(0);
  });
});

describe('M9 interpret 迟到补扣的角色时长 clamp', () => {
  /** interpret grant：被 deduct 结算，锚点已记 chargedMinutes 分钟。 */
  function interpretGrantSettled(chargedMinutes: number) {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'it:u1:g1', input_audio_duration_ms: 900_000 },
      ])
    );
    grantUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    grantFindUniqueMock.mockResolvedValueOnce({
      userId: 'u1',
      sessionId: null,
      interpretSessionId: 'i1',
      settledAt: new Date('2026-07-16T11:50:00.000Z'),
      settledBy: 'interpret_deduct',
      maxSessionSeconds: 900,
      billedMinutes: null,
    });
    txInterpretFindUniqueMock.mockResolvedValueOnce({ billedMinutes: chargedMinutes });
    // 本锚点名下 12 条流 × 15 分钟 = 实测 3 小时。
    txGrantFindManyMock.mockResolvedValueOnce(
      Array.from({ length: 12 }, () => ({
        actualMs: 900_000,
        maxSessionSeconds: 900,
        billedMinutes: null,
      }))
    );
  }

  it('FREE 用户实测 3h、已按 2h 上限扣过 → 差额 0，绝不补扣超上限那 60 分钟', async () => {
    // 旧代码：getBillableMinutes(10_800_000) - 120 - 0 = 180 - 120 = 60 → 足额补扣，
    // 把「FREE 2h / PRO 4h 是刻意的用户保护」这条（realtime 分支白纸黑字写着的）绕过去了。
    interpretGrantSettled(120);
    txUserFindUniqueMock.mockResolvedValueOnce({ role: 'FREE' });

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(txUserFindUniqueMock).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { role: true },
    });
    expect(deductMock).not.toHaveBeenCalled();
    expect(stats.lateCharged).toBe(0);
    expect(stats.backfilled).toBe(1);
  });

  it('ADMIN 无时长上限 → 同样的实测量仍按全额补差（证明 clamp 是按角色而非一刀切）', async () => {
    interpretGrantSettled(120);
    txUserFindUniqueMock.mockResolvedValueOnce({ role: 'ADMIN' });

    await reconcileSonioxStreamUsage(NOW);

    // 180 - 120 = 60
    expect(deductMock).toHaveBeenCalledWith('u1', 60, TX);
  });
});

describe('M10 孤儿扫描：被跳过的 grant 不占批量名额', () => {
  it('整整一页都是活跃会话的 grant → 翻页继续找，真孤儿不被饿死', async () => {
    // 第一页 200 条全部属于仍在 RECORDING 的会话（长课堂高峰的真实形态）。
    // 旧实现「最老 200 条一刀切」在这里就到顶了，真孤儿永远进不了窗口。
    const activePage = Array.from({ length: 200 }, (_, i) =>
      orphanGrant({ id: `g-active-${i}`, sessionId: 's-active' })
    );
    grantFindManyMock.mockResolvedValueOnce(activePage);
    grantFindManyMock.mockResolvedValueOnce([
      orphanGrant({ id: 'g-real-orphan', sessionId: 's-dead' }),
    ]);
    sessionFindUniqueMock.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === 's-dead' ? { status: 'CREATED' } : { status: 'RECORDING' }
    );
    settleGrantsMock.mockResolvedValue({
      settledCount: 1,
      releasedMinutes: 15,
      actualMsTotal: 300_000,
    });

    const stats = await reconcileSonioxStreamUsage(NOW);

    // 翻了第二页，且带上第一页末尾的游标。
    expect(grantFindManyMock).toHaveBeenCalledTimes(2);
    expect(grantFindManyMock.mock.calls[1][0]).toMatchObject({
      cursor: { id: 'g-active-199' },
      skip: 1,
    });
    // 真孤儿被处理（旧代码这里是 0）。
    expect(settleGrantsMock).toHaveBeenCalledWith(
      { grantId: 'g-real-orphan' },
      'usage_cron',
      TX
    );
    expect(stats.orphanCharged).toBe(1);
  });

  it('查询层已把「肯定还没到期」的新 grant 挡在外面（名额只花在真候选上）', async () => {
    grantFindManyMock.mockResolvedValueOnce([]);

    await reconcileSonioxStreamUsage(NOW);

    const where = grantFindManyMock.mock.calls[0][0].where;
    expect(where.settledAt).toBeNull();
    // now - keyTTL(60s) - grace(30min)
    expect((where.mintedAt.lte as Date).getTime()).toBe(
      NOW.getTime() - 60_000 - 30 * 60_000
    );
  });
});
