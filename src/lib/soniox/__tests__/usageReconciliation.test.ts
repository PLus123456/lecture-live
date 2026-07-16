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
  grantUpdateMock,
  sessionFindUniqueMock,
  interpretFindUniqueMock,
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
  return {
    siteFindUniqueMock: vi.fn(),
    siteUpsertMock: vi.fn(),
    grantUpdateManyMock,
    grantFindUniqueMock: vi.fn(),
    grantFindManyMock: vi.fn(),
    grantUpdateMock,
    sessionFindUniqueMock: vi.fn(),
    interpretFindUniqueMock: vi.fn(),
    transactionMock: vi.fn(),
    deductMock: vi.fn(),
    regionConfigMock: vi.fn(),
    settleGrantsMock: vi.fn(),
    logSystemEventMock: vi.fn(),
    fetchMock: vi.fn(),
    // $transaction 注入的 tx：迟到补扣/孤儿转扣在事务内写 grant 台账。
    TX: {
      sonioxStreamGrant: { update: grantUpdateMock, updateMany: grantUpdateManyMock },
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
  grantUpdateMock.mockReset();
  sessionFindUniqueMock.mockReset();
  interpretFindUniqueMock.mockReset();
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
  grantUpdateMock.mockResolvedValue({});
  sessionFindUniqueMock.mockResolvedValue(null);
  interpretFindUniqueMock.mockResolvedValue(null);
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
  it('回填成功且 grant 已被权威路径结算 → 只回填不补扣，推进 watermark', async () => {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'rt:u1:g1', input_audio_duration_ms: 20017 },
      ])
    );
    grantUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    grantFindUniqueMock.mockResolvedValueOnce({
      userId: 'u1',
      settledAt: new Date('2026-07-16T11:00:00.000Z'),
      settledBy: 'session_finalize',
      maxSessionSeconds: 900,
    });

    const stats = await reconcileSonioxStreamUsage(NOW);

    // CAS：id+userId（纵深防御）+ actualMs IS NULL 才写入
    expect(grantUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 'g1', userId: 'u1', actualMs: null },
      data: { actualMs: 20017, usageLogUuid: 'log1' },
    });
    // 已被 finalize 结算（非退款）→ 不逐 grant 补扣
    expect(transactionMock).not.toHaveBeenCalled();
    expect(deductMock).not.toHaveBeenCalled();
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

  it('迟到补扣：曾按无用量退款（usage_refund）的 grant 冒出用量 → 事务内补扣实测分钟并改写台账', async () => {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'rt:u1:g1', input_audio_duration_ms: 20017 },
      ])
    );
    grantUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    grantFindUniqueMock.mockResolvedValueOnce({
      userId: 'u1',
      settledAt: new Date('2026-07-16T10:00:00.000Z'),
      settledBy: 'usage_refund',
      maxSessionSeconds: 900,
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

  it('CAS 失败（actualMs 已回填过，重叠窗重复条目）→ skipped，不再查 grant', async () => {
    fetchMock.mockResolvedValueOnce(
      usagePage([
        { uuid: 'log1', client_reference_id: 'rt:u1:g1', input_audio_duration_ms: 20017 },
      ])
    );
    grantUpdateManyMock.mockResolvedValueOnce({ count: 0 });

    const stats = await reconcileSonioxStreamUsage(NOW);

    expect(grantUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(grantFindUniqueMock).not.toHaveBeenCalled();
    expect(stats.backfilled).toBe(0);
    expect(stats.lateCharged).toBe(0);
    expect(stats.logsSeen).toBe(1);
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
