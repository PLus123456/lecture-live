// src/lib/soniox/usageReconciliation.ts
// R1-L3：Soniox /v1/usage-logs 对账 cron。
//
// mint 时下发的 client_reference_id（kind:userId:grantId，服务端构造）让每条直连串流在 Soniox
// 侧留下可归属的用量记录（实测：max_session 硬断、进程被杀式暴力断连的流都入账，仅「铸了从未
// 连接」的 key 无记录；落账延迟 <15s）。本模块每个维护周期增量拉取，做三件事：
//  1. 回填：按 grantId 把实测串流毫秒写进 grant.actualMs（CAS 恰好一次）——interpret cron 与
//     finalize auto-reclaim 的精确时长口径来源；
//  2. 孤儿结算：过期未结、且无任何内容实体（Session/InterpretSession 活跃链路）接手的 grant——
//     有用量按实测转实扣（改装客户端「只串流不收尾」的最终收费点），无用量退预扣（key 没用过，
//     页面秒关的诚实用户不吃亏）；
//  3. 迟到补扣：曾被退款（usage_refund/mint_failed）的 grant 若事后冒出用量记录（usage-logs
//     极端迟到/拉取长时间故障后恢复），补扣实测量——退款不能成为白嫖窗口。
//
// 幂等性：回填经 actualMs IS NULL 的条件更新恰好一次；结算经 settledAt 条件认领互斥；窗口重叠
// 重拉无害。watermark 存 SiteSetting（billing_soniox_usage_watermark_<region>），拉取失败不推进。

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { logSystemEvent } from '@/lib/auditLog';
import { deductTranscriptionMinutes } from '@/lib/quota';
import { getRegionConfigAsync } from '@/lib/soniox/env';
import { settleStreamGrants } from '@/lib/soniox/streamGrant';

const usageLogger = logger.child({ component: 'soniox-usage-reconciliation' });

/** 窗口重叠量：每轮拉 [watermark - OVERLAP, now]。实测落账 <15s，15min 超富余；CAS 保证重拉幂等。 */
const FETCH_OVERLAP_MS = 15 * 60_000;
/** 首次运行（无 watermark）回看窗口。部署前无 grant，回看仅为容错。 */
const INITIAL_LOOKBACK_MS = 24 * 60 * 60_000;
/** usage-logs API 单窗上限 31 天，留余量。 */
const MAX_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** 孤儿判定：mintedAt + key TTL + 连接硬上限之后再等这么久（等 usage-log 落账+回填）。 */
const ORPHAN_SETTLE_GRACE_MS = 30 * 60_000;
/** 每轮孤儿结算批量上限（维护循环 15min 一轮，积压会被后续轮次消化）。 */
const ORPHAN_BATCH_SIZE = 200;

const WATERMARK_KEY_PREFIX = 'billing_soniox_usage_watermark_';
const SONIOX_REGIONS = ['us', 'eu', 'jp'] as const;

interface SonioxUsageLogEntry {
  uuid: string;
  client_reference_id?: string | null;
  input_audio_duration_ms?: number | null;
  end_time?: string | null;
}

export interface SonioxUsageReconciliationStats {
  regionsPolled: number;
  logsSeen: number;
  backfilled: number;
  lateCharged: number;
  orphanCharged: number;
  orphanRefunded: number;
}

/** client_reference_id 解析：'rt:<userId>:<grantId>' / 'it:<userId>:<grantId>'（服务端构造）。 */
function parseGrantReference(
  ref: string | null | undefined
): { userId: string; grantId: string } | null {
  if (!ref) return null;
  const match = /^(rt|it):([^:]+):([^:]+)$/.exec(ref);
  if (!match) return null;
  return { userId: match[2], grantId: match[3] };
}

async function readWatermark(region: string): Promise<Date | null> {
  const row = await prisma.siteSetting.findUnique({
    where: { key: `${WATERMARK_KEY_PREFIX}${region}` },
  });
  if (!row) return null;
  const parsed = new Date(row.value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function writeWatermark(region: string, value: Date): Promise<void> {
  await prisma.siteSetting.upsert({
    where: { key: `${WATERMARK_KEY_PREFIX}${region}` },
    create: { key: `${WATERMARK_KEY_PREFIX}${region}`, value: value.toISOString() },
    update: { value: value.toISOString() },
  });
}

/** 分页拉一个区域窗口内的全部 usage logs（cursor 直到耗尽；任何一页失败即抛，本轮不推进 watermark）。 */
async function fetchRegionUsageLogs(
  restBaseUrl: string,
  apiKey: string,
  startTime: Date,
  endTime: Date
): Promise<SonioxUsageLogEntry[]> {
  const collected: SonioxUsageLogEntry[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL(`${restBaseUrl}/v1/usage-logs`);
    url.searchParams.set('start_time', startTime.toISOString());
    url.searchParams.set('end_time', endTime.toISOString());
    url.searchParams.set('limit', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`usage-logs fetch failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      usage_logs?: SonioxUsageLogEntry[];
      next_page_cursor?: string | null;
    };
    collected.push(...(data.usage_logs ?? []));
    cursor = data.next_page_cursor ?? null;
  } while (cursor);
  return collected;
}

/**
 * 回填一条 usage log 到对应 grant（actualMs CAS 恰好一次），并处理迟到补扣。
 * 返回 'backfilled' | 'late_charged' | 'skipped'。
 */
async function applyUsageLogToGrant(
  entry: SonioxUsageLogEntry
): Promise<'backfilled' | 'late_charged' | 'skipped'> {
  const ref = parseGrantReference(entry.client_reference_id);
  if (!ref) return 'skipped';
  const actualMs = Math.max(0, Math.floor(entry.input_audio_duration_ms ?? 0));

  // CAS 回填：仅第一次写入生效（窗口重叠重拉/重复条目天然幂等）。userId 一并匹配（纵深防御：
  // ref 是我们签发时构造的，但仍不信任外部数据到能直接当主键用）。
  const backfill = await prisma.sonioxStreamGrant.updateMany({
    where: { id: ref.grantId, userId: ref.userId, actualMs: null },
    data: { actualMs, usageLogUuid: entry.uuid },
  });
  if (backfill.count === 0) {
    return 'skipped';
  }

  if (actualMs <= 0) {
    return 'backfilled';
  }

  // 迟到补扣：该 grant 若已被「无用量」路径结算（退了预扣/签发失败回滚），而实测有用量——
  // 说明 usage-log 极端迟到或拉取曾长期故障。按实测补扣（封顶单连接硬上限），杜绝「退款窗口=
  // 白嫖窗口」。已被 finalize/deduct/interpret-cron 结算的不逐 grant 补——那些路径按整场权威
  // 口径扣过，grant 实测只作审计。回填 CAS 已保证本分支对同一 grant 至多进入一次。
  const grant = await prisma.sonioxStreamGrant.findUnique({
    where: { id: ref.grantId },
    select: {
      userId: true,
      settledAt: true,
      settledBy: true,
      maxSessionSeconds: true,
    },
  });
  if (
    grant &&
    grant.settledAt &&
    (grant.settledBy === 'usage_refund' || grant.settledBy === 'mint_failed')
  ) {
    const capMinutes = Math.max(1, Math.ceil(grant.maxSessionSeconds / 60));
    const minutes = Math.min(Math.ceil(actualMs / 60_000), capMinutes);
    await prisma.$transaction(async (tx) => {
      const snap = await deductTranscriptionMinutes(grant.userId, minutes, tx);
      await tx.sonioxStreamGrant.update({
        where: { id: ref.grantId },
        data: {
          billedMinutes: snap && snap.role !== 'ADMIN' ? minutes : 0,
          settledBy: 'usage_cron',
        },
      });
    });
    logSystemEvent(
      'soniox.late_usage_charged',
      JSON.stringify({ grantId: ref.grantId, userId: grant.userId, actualMs, minutes })
    );
    return 'late_charged';
  }
  return 'backfilled';
}

/**
 * 孤儿 grant 结算：过期未结、且无内容实体活跃链路接手的 grant。
 *  - realtime：所属 Session 仍在 RECORDING/PAUSED/FINALIZING → 交给 finalize/reclaim（会结算
 *    grants 并按含 grant 实测下限的口径扣费），跳过；CREATED/COMPLETED/查无 → 这里处理。
 *  - interpret：所属锚点仍未结算 → 交给 interpret cron（7h，按 grants 实测扣），跳过；已结算/
 *    无锚点关联 → 这里处理。
 * 处理：有实测用量按实测转实扣（settledBy=usage_cron，billedMinutes 台账入对账 expected）；
 * 无实测（key 从未建立连接）退预扣（settledBy=usage_refund）。
 */
async function settleOrphanGrants(now: Date): Promise<{
  orphanCharged: number;
  orphanRefunded: number;
}> {
  let orphanCharged = 0;
  let orphanRefunded = 0;

  const candidates = await prisma.sonioxStreamGrant.findMany({
    where: { settledAt: null },
    select: {
      id: true,
      userId: true,
      kind: true,
      sessionId: true,
      interpretSessionId: true,
      reservedMinutes: true,
      maxSessionSeconds: true,
      mintedAt: true,
      actualMs: true,
    },
    orderBy: { mintedAt: 'asc' },
    take: ORPHAN_BATCH_SIZE,
  });

  for (const grant of candidates) {
    const expiresAtMs =
      grant.mintedAt.getTime() +
      60_000 + // key TTL：过期后无法再建连
      grant.maxSessionSeconds * 1000 + // 已建连接的串流硬上限（Soniox 强制断）
      ORPHAN_SETTLE_GRACE_MS;
    if (expiresAtMs > now.getTime()) {
      continue; // 仍可能在串流/等落账
    }

    // 归属活跃性：有内容实体接手的留给其权威结算链路（它们的口径覆盖整场且会结算 grants）。
    if (grant.kind === 'realtime' && grant.sessionId) {
      const session = await prisma.session.findUnique({
        where: { id: grant.sessionId },
        select: { status: true },
      });
      if (
        session &&
        ['RECORDING', 'PAUSED', 'FINALIZING'].includes(session.status)
      ) {
        continue;
      }
    } else if (grant.kind === 'interpret' && grant.interpretSessionId) {
      const anchor = await prisma.interpretSession.findUnique({
        where: { id: grant.interpretSessionId },
        select: { settledAt: true },
      });
      if (anchor && anchor.settledAt === null) {
        continue;
      }
    }

    const actualMs = grant.actualMs ?? 0;
    try {
      if (actualMs > 0) {
        // 有用量：转实扣。settle（释放预扣）+ 扣实测 + 记 grant 台账同事务，恰好一次
        // （settledAt CAS 输给并发 finalize/deduct 则整体跳过）。
        const capMinutes = Math.max(1, Math.ceil(grant.maxSessionSeconds / 60));
        const minutes = Math.min(Math.ceil(actualMs / 60_000), capMinutes);
        const charged = await prisma.$transaction(async (tx) => {
          const settled = await settleStreamGrants(
            { grantId: grant.id },
            'usage_cron',
            tx
          );
          if (settled.settledCount !== 1) return false;
          const snap = await deductTranscriptionMinutes(grant.userId, minutes, tx);
          await tx.sonioxStreamGrant.update({
            where: { id: grant.id },
            data: { billedMinutes: snap && snap.role !== 'ADMIN' ? minutes : 0 },
          });
          return true;
        });
        if (charged) {
          orphanCharged += 1;
          // 改装指纹：正常客户端的 grant 几乎全部经 finalize/deduct 结算，孤儿转扣占比高
          // 即「mint 后从不收尾」的行为特征，供告警/封禁决策（audit log 可聚合）。
          logSystemEvent(
            'soniox.orphan_grant_charged',
            JSON.stringify({
              grantId: grant.id,
              userId: grant.userId,
              kind: grant.kind,
              actualMs,
              minutes,
            })
          );
        }
      } else {
        // 无用量：key 从未建立连接（实测未用 key 不产生 usage-log）。全额退预扣。
        // 若 usage-log 极端迟到，回填路径的「迟到补扣」会追回——退款不构成白嫖窗口。
        const settled = await settleStreamGrants(
          { grantId: grant.id },
          'usage_refund'
        );
        if (settled.settledCount === 1) {
          orphanRefunded += 1;
        }
      }
    } catch (err) {
      usageLogger.error(
        {
          grantId: grant.id,
          message: err instanceof Error ? err.message : String(err),
        },
        'orphan grant settlement failed; will retry next cycle'
      );
    }
  }

  return { orphanCharged, orphanRefunded };
}

/**
 * 主入口：每个维护周期调用（billingMaintenance）。
 * 各区域独立增量拉取（互不阻塞，单区失败不推进该区 watermark、下轮重试），然后统一做孤儿结算。
 */
export async function reconcileSonioxStreamUsage(
  now: Date = new Date()
): Promise<SonioxUsageReconciliationStats> {
  const stats: SonioxUsageReconciliationStats = {
    regionsPolled: 0,
    logsSeen: 0,
    backfilled: 0,
    lateCharged: 0,
    orphanCharged: 0,
    orphanRefunded: 0,
  };

  for (const region of SONIOX_REGIONS) {
    let config;
    try {
      config = await getRegionConfigAsync(region);
    } catch {
      config = null;
    }
    if (!config || config.region !== region) {
      continue; // 该区未配置
    }

    try {
      const watermark = await readWatermark(region);
      const startTime = new Date(
        Math.max(
          (watermark?.getTime() ?? now.getTime() - INITIAL_LOOKBACK_MS) -
            FETCH_OVERLAP_MS,
          now.getTime() - MAX_WINDOW_MS
        )
      );
      const logs = await fetchRegionUsageLogs(
        config.restBaseUrl,
        config.apiKey,
        startTime,
        now
      );
      stats.regionsPolled += 1;
      stats.logsSeen += logs.length;

      for (const entry of logs) {
        try {
          const outcome = await applyUsageLogToGrant(entry);
          if (outcome === 'backfilled') stats.backfilled += 1;
          if (outcome === 'late_charged') stats.lateCharged += 1;
        } catch (err) {
          usageLogger.error(
            {
              uuid: entry.uuid,
              message: err instanceof Error ? err.message : String(err),
            },
            'failed to apply usage log entry; will retry via overlap window'
          );
        }
      }

      // 整窗拉取成功才推进（重叠 15min 覆盖迟到写入；条目级失败靠重叠窗重试）。
      await writeWatermark(region, now);
    } catch (err) {
      usageLogger.warn(
        {
          region,
          message: err instanceof Error ? err.message : String(err),
        },
        'usage-logs poll failed for region; watermark not advanced'
      );
    }
  }

  const orphanStats = await settleOrphanGrants(now);
  stats.orphanCharged = orphanStats.orphanCharged;
  stats.orphanRefunded = orphanStats.orphanRefunded;

  if (
    stats.backfilled > 0 ||
    stats.lateCharged > 0 ||
    stats.orphanCharged > 0 ||
    stats.orphanRefunded > 0
  ) {
    usageLogger.info(stats, 'soniox usage reconciliation cycle complete');
  }
  return stats;
}
