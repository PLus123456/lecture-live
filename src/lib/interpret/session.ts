// src/lib/interpret/session.ts
// B3：同声传译的服务端持久化会话 + 兜底结算。
//
// interpret 浏览器直连 Soniox，服务端只在 /start 与 /deduct 观测。旧实现若客户端不调 /deduct
// （改装 / 掉线 / 故意）则整场免费、无兜底。这里在 /start 落一行 InterpretSession(settledAt=null)，
// /deduct 成功扣费前**原子认领**它(设 settledAt)，cron 对超时仍未结算的按服务端墙钟(startedAt→now，
// 封顶 MAX_INTERPRET_DURATION_MS)兜底扣费并结算。deduct 与 cron 经 settledAt 的条件认领互斥 →
// 每场恰好扣一次：杜绝「不调 deduct 白嫖」与「deduct+cron 双扣」。

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { getBillableMinutes } from '@/lib/billing';
import { deductTranscriptionMinutes, recordInterpretUsage } from '@/lib/quota';
import { MAX_INTERPRET_DURATION_MS } from '@/lib/interpret/anchor';

/** 可选 Prisma 客户端：默认全局 `prisma`；deduct 传入 $transaction 的 tx 使认领与扣费同事务原子。 */
type InterpretDbClient = Prisma.TransactionClient;

const sessionLogger = logger.child({ component: 'interpret-session' });

// 兜底阈值：> MAX_INTERPRET_DURATION_MS(6h) 留足余量，避免误扫「合法长会话、稍后会正常 deduct」的在途会话。
export const INTERPRET_RECLAIM_STALE_MS = 7 * 60 * 60_000;

/**
 * /start：为一次同传会话落一行未结算记录。anchorId 供 /deduct 精确认领（Redis 不可用时为 null）。
 * best-effort：建行失败不阻塞 interpret 启动（退化到旧行为——纯靠 /deduct 计费、无 cron 兜底）。
 */
export async function createInterpretSession(
  userId: string,
  anchorId: string | null
): Promise<void> {
  try {
    await prisma.interpretSession.create({ data: { userId, anchorId } });
  } catch (err) {
    sessionLogger.warn(
      { userId, message: err instanceof Error ? err.message : String(err) },
      'failed to create interpret session record'
    );
  }
}

export interface EnsureInterpretResult {
  /** 复用/新建的锚点 id；创建失败（DB 故障）时为 null（best-effort，不阻塞发 key）。 */
  id: string | null;
  /** 是否本次新建（true=补建了缺失锚点，即客户端跳过了 /start）。 */
  created: boolean;
}

/**
 * R1-C：在 temporary-key 签发（唯一必经的服务端点）时，保证该用户有一条「活的」未结算
 * InterpretSession 锚点。
 *
 * 堵 skip /start 白嫖①：改装客户端跳过 /interpret/start 直接反复取 key 串流时，B3 的 cron 兜底
 * （reclaimStaleInterpretSessions）没有对象可结算 → 整场免费。这里在 mint 时为其补建锚点，使
 * cron 能按服务端墙钟兜底扣费（未结算超时按 startedAt→now 封顶 MAX_INTERPRET 扣）。
 *
 * 语义：找该用户最近一条 settledAt=null 且 startedAt 在 MAX_INTERPRET 窗口内的锚点 —— 有则复用
 * （honest 客户端 /start 建的锚点，或本串流早前 mint 补建的锚点；避免每次 mint 都建新行），无则
 * 新建（startedAt=now、anchorId=null）。best-effort：任何失败都不抛（绝不阻塞发 key）。
 *
 * **堵不住**「/start 后立刻 /deduct(≈0) 早结算再继续单连接串流」②：早结算把锚点 settledAt 置非空、
 * 移出 cron，而单连接串流不再 re-mint（实测 Soniox 连接可存活远超 60s key、无需续 key），服务端再
 * 无观测点。② 与「realtime 用假 sessionId 无 Session 串流」都需服务端 WS 代理(A)才能彻底解 —— 见
 * 计费审计说明。本函数只把「懒惰/意外跳过 /start」从免费降级为 cron 兜底计费。
 */
export async function ensureActiveInterpretSession(
  userId: string,
  now: Date = new Date()
): Promise<EnsureInterpretResult> {
  try {
    const recentThreshold = new Date(now.getTime() - MAX_INTERPRET_DURATION_MS);
    // 复用最近的活锚点（honest 客户端 /start 已建；本串流早前 mint 已补建）。窗口外的陈旧未结算
    // 锚点不复用——那是上一场崩溃残留、交给 cron 兜底，新场补建独立锚点，避免把新场并进旧 startedAt。
    const existing = await prisma.interpretSession.findFirst({
      where: { userId, settledAt: null, startedAt: { gte: recentThreshold } },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    if (existing) {
      return { id: existing.id, created: false };
    }
    const created = await prisma.interpretSession.create({
      data: { userId, anchorId: null, startedAt: now },
      select: { id: true },
    });
    return { id: created.id, created: true };
  } catch (err) {
    sessionLogger.warn(
      { userId, message: err instanceof Error ? err.message : String(err) },
      'ensureActiveInterpretSession failed (non-blocking; key mint proceeds)'
    );
    return { id: null, created: false };
  }
}

export type InterpretClaimOutcome = 'claimed' | 'already_settled' | 'no_record';

export interface InterpretClaimResult {
  outcome: InterpretClaimOutcome;
  sessionId: string | null;
}

/**
 * /deduct：原子认领本次同传会话（置 settledAt），与 cron 兜底互斥。
 *   - anchorId 命中一条未结算会话 → 认领并返回 'claimed'（调用方据此正常扣费）。
 *   - 目标会话已被 cron 结算 → 'already_settled'（调用方**跳过扣费**，避免双扣）。
 *   - 查无记录（会话早于 B3 部署 / Redis 曾不可用没建行 / 边缘）→ 'no_record'（调用方按旧行为扣费兜底）。
 * 无 anchorId（降级）时认领该用户**最旧**的未结算会话。
 */
export async function claimInterpretSessionForDeduct(
  userId: string,
  anchorId: string | null,
  db: InterpretDbClient = prisma
): Promise<InterpretClaimResult> {
  const target = anchorId
    ? await db.interpretSession.findFirst({
        where: { anchorId, userId },
        orderBy: { startedAt: 'desc' },
        select: { id: true, settledAt: true },
      })
    : await db.interpretSession.findFirst({
        where: { userId, settledAt: null },
        orderBy: { startedAt: 'asc' },
        select: { id: true, settledAt: true },
      });

  if (!target) {
    return { outcome: 'no_record', sessionId: null };
  }
  if (target.settledAt) {
    return { outcome: 'already_settled', sessionId: target.id };
  }

  // 条件原子认领：仅当仍未结算才置 settledAt。抢不到（cron 先结算）→ already_settled。
  const claimed = await db.interpretSession.updateMany({
    where: { id: target.id, settledAt: null },
    data: { settledAt: new Date(), settledBy: 'deduct' },
  });
  return claimed.count === 1
    ? { outcome: 'claimed', sessionId: target.id }
    : { outcome: 'already_settled', sessionId: target.id };
}

/**
 * cron 兜底：对超时仍未结算的同传会话，按服务端墙钟(startedAt→now，封顶 MAX_INTERPRET_DURATION_MS)
 * 扣费并结算。条件原子认领(WHERE settledAt=null)与 deduct 互斥 → 恰好扣一次。计费失败不回滚结算
 * （已认领即视为已处理，留给对账兜底），避免反复重扫同一会话。
 */
export async function reclaimStaleInterpretSessions(now: Date): Promise<number> {
  const threshold = new Date(now.getTime() - INTERPRET_RECLAIM_STALE_MS);
  const stale = await prisma.interpretSession.findMany({
    where: { settledAt: null, startedAt: { lte: threshold } },
    select: { id: true, userId: true, startedAt: true },
    take: 500,
    orderBy: { startedAt: 'asc' },
  });

  let reclaimed = 0;
  for (const s of stale) {
    const elapsedMs = Math.min(
      Math.max(0, now.getTime() - s.startedAt.getTime()),
      MAX_INTERPRET_DURATION_MS
    );
    const billable = getBillableMinutes(elapsedMs);

    // 认领 + 扣费 + 记台账**同事务**原子：任一步失败整体回滚 → 会话保持未结算(settledAt=null)、
    // 下个周期重试，杜绝「已结算却没扣费」的静默免单（审查 R2/R7 的 cron 侧同构）。与 /deduct 经
    // settledAt 条件认领互斥（claimed.count!==1 = deduct 抢先）→ 恰好扣一次。
    const settled = await prisma
      .$transaction(async (tx) => {
        const claimed = await tx.interpretSession.updateMany({
          where: { id: s.id, settledAt: null },
          data: { settledAt: now, settledBy: 'cron_reclaim', billedMinutes: billable },
        });
        if (claimed.count !== 1) {
          return false; // deduct 抢先结算
        }
        if (billable > 0) {
          const snap = await deductTranscriptionMinutes(s.userId, billable, tx);
          // ADMIN 恒不扣费（snap.role==='ADMIN' 即 deduct 短路），不记台账。
          if (snap && snap.role !== 'ADMIN') {
            await recordInterpretUsage(s.userId, billable, elapsedMs, tx);
          }
        }
        return true;
      })
      .catch((err) => {
        sessionLogger.error(
          { sessionId: s.id, userId: s.userId, message: err instanceof Error ? err.message : String(err) },
          'interpret reclaim tx failed; left unsettled for next cycle'
        );
        return false;
      });

    if (settled) {
      reclaimed += 1;
      sessionLogger.warn(
        { sessionId: s.id, userId: s.userId, billable },
        'reclaimed stale unsettled interpret session (server-side fallback billing)'
      );
    }
  }
  return reclaimed;
}
