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
//  3. 迟到补扣：已结算的 grant 事后冒出用量记录（usage-logs 极端迟到/拉取长时间故障后恢复）时
//     补收——曾被退款（usage_refund/mint_failed）的按实测全额补，已按整场权威口径结算的
//     （interpret_deduct/session_finalize/interpret_cron）补「实测 − 已扣」的差额（P1-2）。
//     没有这一条，「提前结算 → 继续串到硬上限」就是零成本白嫖。
//
// 幂等性：回填经 actualMs IS NULL 的条件更新恰好一次；结算经 settledAt 条件认领互斥；窗口重叠
// 重拉无害。回填与补扣同一事务（P5-17），失败整体回滚且不推进 watermark，下轮真能重试。
// watermark 存 SiteSetting（billing_soniox_usage_watermark_<region>），拉取失败不推进。

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { logSystemEvent } from '@/lib/auditLog';
import {
  clampSessionDurationMs,
  getBillableMinutes,
  type AppUserRole,
} from '@/lib/billing';
import { MAX_INTERPRET_DURATION_MS } from '@/lib/interpret/anchor';
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
/** 每轮孤儿结算批量上限：本轮**真正处理**（尝试结算）的 grant 数上限，被跳过的不计入。 */
const ORPHAN_BATCH_SIZE = 200;
/** 孤儿扫描单页大小（游标分页；被跳过的行靠翻页绕过，不占 ORPHAN_BATCH_SIZE 名额）。 */
const ORPHAN_SCAN_PAGE_SIZE = 200;
/**
 * M10：单轮最多扫描多少行。旧实现是「最老 200 条」一刀切，而循环里对**仍属活跃 Session /
 * 未结算锚点**的 grant 只是 `continue` 跳过 —— 被跳过的行照样占满这 200 个名额。上课高峰下
 * 约 13 个并发 4h 长会话（每 15 分钟一条 grant）就能让最老 200 条全是活跃 grant，每轮全被
 * 跳过，真孤儿（客户端崩溃、页面被杀）永远进不了窗口，从「设计上延迟 30 分钟」变成饿死。
 * 改为游标分页：翻页绕过被跳过项，直到攒够 ORPHAN_BATCH_SIZE 个真正处理的，或扫到本上限。
 * 上限存在的意义只是防病态数据把维护周期拖死（15min 一轮，下轮从头再扫）。
 */
const MAX_ORPHAN_SCAN_ROWS = 5_000;

const WATERMARK_KEY_PREFIX = 'billing_soniox_usage_watermark_';
const SONIOX_REGIONS = ['us', 'eu', 'jp'] as const;

/** 按「无用量」结算过的 grant：实测冒出来即全额补扣（退款窗口不是白嫖窗口）。 */
const REFUNDED_SETTLED_BY = new Set(['usage_refund', 'mint_failed']);
/** 按整场权威口径结算过的 grant：只补「实测 − 已扣」的差额（P1-2）。 */
const AUTHORITATIVE_SETTLED_BY = new Set([
  'interpret_deduct',
  'session_finalize',
  'interpret_cron',
]);

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

/** 迟到补扣的 grant 快照（applyUsageLogToGrant 事务内读取）。 */
interface LateChargeGrant {
  userId: string;
  sessionId: string | null;
  interpretSessionId: string | null;
  maxSessionSeconds: number;
  billedMinutes: number | null;
}

/**
 * P1-2：已按**整场权威口径**结算过的 grant 冒出迟到实测量时，补扣「实测 − 已扣」的差额。
 *
 * 堵的洞：/start → mint 预扣 15min → 60s 容差内 `deduct{durationMs:0}` 提前结算 → 流继续跑到
 * Soniox 硬上限。结算走的是 releaseTranscriptionMinutes（纯退额度、非转实扣），净消耗 0 →
 * 可无限循环；孤儿扫描只捞 settledAt=null，对已结算的 grant 零兜底。同款也覆盖 realtime：
 * usage-log 落在 finalize 之后时，finalize 的 grant 实测下限（P5-6）取到的是 0。
 *
 * 口径必须**按实体（锚点/会话）整场算**，不能逐 grant 算：一场多条流时逐 grant 会各自减去同一个
 * 「已扣」，把差额重复补出来。故：实体全部 grants 的实测分钟合计 − 实体台账已扣 − 各 grant 已补扣。
 */
async function computeLateTopUpMinutes(
  tx: Prisma.TransactionClient,
  grant: LateChargeGrant
): Promise<number> {
  const siblingWhere = grant.interpretSessionId
    ? { interpretSessionId: grant.interpretSessionId }
    : grant.sessionId
      ? { sessionId: grant.sessionId }
      : null;
  if (!siblingWhere) return 0; // 无实体归属：孤儿扫描的地盘，这里不猜

  const siblings = await tx.sonioxStreamGrant.findMany({
    where: siblingWhere,
    select: { actualMs: true, maxSessionSeconds: true, billedMinutes: true },
  });
  let measuredMs = 0;
  let grantChargedMinutes = 0;
  for (const sibling of siblings) {
    // 每条流先各自封顶自己的单连接硬上限（防 Soniox 侧异常大值），再合计。
    measuredMs += Math.min(
      Math.max(0, sibling.actualMs ?? 0),
      sibling.maxSessionSeconds * 1000
    );
    grantChargedMinutes += Math.max(0, sibling.billedMinutes ?? 0);
  }

  if (grant.interpretSessionId) {
    const anchor = await tx.interpretSession.findUnique({
      where: { id: grant.interpretSessionId },
      select: { billedMinutes: true },
    });
    const charged = Math.max(0, anchor?.billedMinutes ?? 0);
    // M9：角色时长上限（FREE 2h / PRO 4h）是刻意的用户保护，补扣不得绕过它 —— 下面的
    // realtime 分支早就写明并做了 clamp，interpret 分支此前直接拿 measuredMs 算差额，
    // 于是「锚点异常长寿（cron 兜底前持续 mint）+ usage-log 迟到回填」会让 FREE 用户被
    // 足额补扣超出保护上限的那一段。这里补齐同款两道封顶：
    //   ① interpret 自己的单场硬上限 MAX_INTERPRET_DURATION_MS(6h) —— deduct 路由的 chargeMs
    //      与 cron 兜底的 elapsedMs 都封了，只有本分支漏封；
    //   ② 角色 clamp（ADMIN 无上限，clampSessionDurationMs 原样返回）。
    const owner = await tx.user.findUnique({
      where: { id: grant.userId },
      select: { role: true },
    });
    if (!owner) return 0; // 用户已删：与 realtime 分支的 `if (!session) return 0` 同口径
    const measuredMinutes = getBillableMinutes(
      clampSessionDurationMs(
        Math.min(measuredMs, MAX_INTERPRET_DURATION_MS),
        owner.role as AppUserRole
      )
    );
    return Math.max(0, measuredMinutes - charged - grantChargedMinutes);
  }

  const session = await tx.session.findUnique({
    where: { id: grant.sessionId as string },
    select: {
      durationMs: true,
      billedMinutes: true,
      user: { select: { role: true } },
    },
  });
  if (!session) return 0;
  // 角色时长上限（FREE 2h / PRO 4h）是刻意的用户保护，补扣不得绕过它 —— 实测量同样过 clamp。
  const measuredMinutes = getBillableMinutes(
    clampSessionDurationMs(measuredMs, session.user.role)
  );
  // finalize 把 durationMs 写成「含 grant 实测的 Math.max 再 clamp」，getBillableMinutes(它) 就是
  // 本场权威扣费额；Session.billedMinutes 台账在时更精确。取两者较大者：宁可少补，绝不重复扣。
  const charged = Math.max(
    Math.max(0, session.billedMinutes ?? 0),
    getBillableMinutes(session.durationMs ?? 0)
  );
  return Math.max(0, measuredMinutes - charged - grantChargedMinutes);
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

  // P5-17：回填 CAS 与迟到补扣放**同一事务**。旧实现回填先自动提交、补扣另起事务，中间任何失败
  // 都是永久漏扣——actualMs 已非 null，重叠窗重拉被 CAS 挡在门口，再没有第二次机会。同事务后
  // 补扣失败即整体回滚（actualMs 回到 null），下轮重叠窗自然重试。
  const result = await prisma.$transaction(async (tx) => {
    // CAS 回填：仅第一次写入生效（窗口重叠重拉/重复条目天然幂等）。userId 一并匹配（纵深防御：
    // ref 是我们签发时构造的，但仍不信任外部数据到能直接当主键用）。
    const backfill = await tx.sonioxStreamGrant.updateMany({
      where: { id: ref.grantId, userId: ref.userId, actualMs: null },
      data: { actualMs, usageLogUuid: entry.uuid },
    });
    if (backfill.count === 0) {
      // L23：CAS 没写进去有两种成因，此前被一视同仁地静默丢弃：
      //   ① 重叠窗重拉到**同一条** log（uuid 相同）—— 完全正常，幂等设计就是要这样；
      //   ② 同一 grant 冒出**第二条不同的** log（uuid 不同）—— 这是「一条连接 = 一条
      //      usage-log」这个上游约定被打破了，第二条的用量从此永久不入账（系统性漏账），
      //      而系统一声不吭。
      // 这里把二者分开：② 记审计事件 + warn，供告警聚合发现约定漂移（不自动补扣 —— 真出现
      // 时要先确认 Soniox 侧语义，盲目按第二条补扣可能重复收费）。
      const existing = await tx.sonioxStreamGrant.findUnique({
        where: { id: ref.grantId },
        select: { usageLogUuid: true, actualMs: true },
      });
      if (
        existing?.usageLogUuid &&
        existing.usageLogUuid !== entry.uuid &&
        actualMs > 0
      ) {
        return {
          outcome: 'conflicting_log' as const,
          minutes: 0,
          userId: ref.userId,
          knownUuid: existing.usageLogUuid,
          knownActualMs: existing.actualMs ?? 0,
        };
      }
      return { outcome: 'skipped' as const, minutes: 0, userId: '' };
    }
    if (actualMs <= 0) {
      return { outcome: 'backfilled' as const, minutes: 0, userId: '' };
    }

    const grant = await tx.sonioxStreamGrant.findUnique({
      where: { id: ref.grantId },
      select: {
        userId: true,
        sessionId: true,
        interpretSessionId: true,
        settledAt: true,
        settledBy: true,
        maxSessionSeconds: true,
        billedMinutes: true,
      },
    });
    // 尚未结算：权威路径（finalize/deduct/interpret-cron）或孤儿扫描会读刚回填的 actualMs 结算。
    if (!grant || !grant.settledAt) {
      return { outcome: 'backfilled' as const, minutes: 0, userId: '' };
    }

    const settledBy = grant.settledBy ?? '';
    const refunded = REFUNDED_SETTLED_BY.has(settledBy);
    let minutes = 0;
    if (refunded) {
      // 曾按「无用量」退掉预扣（退款/签发失败回滚），实测却有量 → 全额补扣（封顶单连接硬上限）。
      const capMinutes = Math.max(1, Math.ceil(grant.maxSessionSeconds / 60));
      minutes = Math.min(Math.ceil(actualMs / 60_000), capMinutes);
    } else if (AUTHORITATIVE_SETTLED_BY.has(settledBy)) {
      minutes = await computeLateTopUpMinutes(tx, grant);
    }
    if (minutes <= 0) {
      return { outcome: 'backfilled' as const, minutes: 0, userId: '' };
    }

    const snap = await deductTranscriptionMinutes(grant.userId, minutes, tx);
    await tx.sonioxStreamGrant.update({
      where: { id: ref.grantId },
      data: {
        billedMinutes:
          snap && snap.role !== 'ADMIN'
            ? Math.max(0, grant.billedMinutes ?? 0) + minutes
            : Math.max(0, grant.billedMinutes ?? 0),
        // 退款过的改标 usage_cron（这笔钱现在是 cron 收的）；权威路径结算过的保留原 settledBy，
        // 否则审计流水里再也看不出这场最初是谁结的。
        ...(refunded ? { settledBy: 'usage_cron' } : {}),
      },
    });
    return {
      outcome: 'late_charged' as const,
      minutes,
      userId: grant.userId,
    };
  });

  if (result.outcome === 'late_charged') {
    logSystemEvent(
      'soniox.late_usage_charged',
      JSON.stringify({
        grantId: ref.grantId,
        userId: result.userId,
        actualMs,
        minutes: result.minutes,
      })
    );
  }
  if (result.outcome === 'conflicting_log') {
    // L23：同一 grant 的第二条不同 usage-log。不自动补扣（语义待确认），但必须留痕告警 ——
    // 否则「一条连接=一条 log」的上游约定一旦漂移，漏账会长期静默发生。
    logSystemEvent(
      'soniox.conflicting_usage_log',
      JSON.stringify({
        grantId: ref.grantId,
        userId: result.userId,
        knownUsageLogUuid: result.knownUuid,
        knownActualMs: result.knownActualMs,
        ignoredUsageLogUuid: entry.uuid,
        ignoredActualMs: actualMs,
      })
    );
    usageLogger.warn(
      {
        grantId: ref.grantId,
        knownUsageLogUuid: result.knownUuid,
        ignoredUsageLogUuid: entry.uuid,
        ignoredActualMs: actualMs,
      },
      'second distinct usage-log for the same grant; ignored (one-connection-one-log contract broken)'
    );
    return 'skipped';
  }
  return result.outcome;
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

  // M10：时间闸的**必要条件**下推到 SQL —— 完整判据是
  // `mintedAt + 60s + maxSessionSeconds*1000 + grace <= now`，因 maxSessionSeconds >= 0，
  // `mintedAt <= now - 60s - grace` 是它的必要条件。把「肯定还没到期」的新行直接挡在查询外，
  // 扫描名额只花在真正的候选上（精确判定仍留在循环里，maxSessionSeconds 逐行不同）。
  const mintedBefore = new Date(
    now.getTime() - 60_000 - ORPHAN_SETTLE_GRACE_MS
  );

  let processed = 0;
  let scanned = 0;
  let cursorId: string | null = null;

  // M10：游标分页取代「最老 200 条一刀切」。被跳过的行（未到期 / 仍属活跃实体）不再占用
  // ORPHAN_BATCH_SIZE 名额，翻页继续找真孤儿。orderBy 带上 id 做 tiebreaker，保证 mintedAt
  // 相同的行也有确定顺序（游标分页的正确性前提）。
  scan: while (processed < ORPHAN_BATCH_SIZE && scanned < MAX_ORPHAN_SCAN_ROWS) {
    const page: Array<{
      id: string;
      userId: string;
      kind: string;
      sessionId: string | null;
      interpretSessionId: string | null;
      reservedMinutes: number;
      maxSessionSeconds: number;
      mintedAt: Date;
      actualMs: number | null;
    }> = await prisma.sonioxStreamGrant.findMany({
      where: { settledAt: null, mintedAt: { lte: mintedBefore } },
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
      orderBy: [{ mintedAt: 'asc' }, { id: 'asc' }],
      take: ORPHAN_SCAN_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    if (page.length === 0) {
      break;
    }
    scanned += page.length;
    cursorId = page[page.length - 1].id;

    for (const grant of page) {
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

    // 到这里才算「本轮真正处理了一条」——上面所有 continue 都不占批量名额（M10 的要害）。
    processed += 1;

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

    if (processed >= ORPHAN_BATCH_SIZE) {
      break scan;
    }
    }

    // 最后一页不足一页 ⇒ 已扫到表尾，没有更多候选。
    if (page.length < ORPHAN_SCAN_PAGE_SIZE) {
      break;
    }
  }

  if (scanned >= MAX_ORPHAN_SCAN_ROWS && processed < ORPHAN_BATCH_SIZE) {
    usageLogger.warn(
      { scanned, processed },
      'orphan grant scan hit row cap without filling the batch;积压将由后续周期消化'
    );
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

      let entryFailed = false;
      for (const entry of logs) {
        try {
          const outcome = await applyUsageLogToGrant(entry);
          if (outcome === 'backfilled') stats.backfilled += 1;
          if (outcome === 'late_charged') stats.lateCharged += 1;
        } catch (err) {
          entryFailed = true;
          usageLogger.error(
            {
              uuid: entry.uuid,
              message: err instanceof Error ? err.message : String(err),
            },
            'failed to apply usage log entry; watermark held for retry'
          );
        }
      }

      // P5-17：整窗拉取成功**且逐条都成功**才推进。旧实现「条目级失败靠 15min 重叠窗重试」只在
      // 失败发生在重叠窗内时成立；条目落在窗口更早处时水位线一推就永久丢账。回填 CAS 让重拉幂等，
      // 不推进的代价只是下轮窗口变长（上限 MAX_WINDOW_MS）。
      if (entryFailed) {
        usageLogger.warn(
          { region },
          'some usage log entries failed; watermark not advanced'
        );
      } else {
        await writeWatermark(region, now);
      }
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
