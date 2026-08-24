// src/lib/soniox/streamGrant.ts
// R1-L2：Soniox 临时 key 签发的预扣台账（SonioxStreamGrant）原语。
//
// 浏览器直连 Soniox 串流，mint 临时 key 是唯一必经服务端点。本模块把 mint 变成计费闸门：
//  - 签发前原子预扣 min(D, 剩余额度) 分钟（收缩式；剩 0 拒发）；
//  - key 下发 max_session_duration_seconds=预扣分钟（到点 Soniox 服务端硬断连，实测 20s 上限
//    在 20.1s 断、错误 temp_api_key_session_expired）+ single_use（同 key 第二条连接 401）；
//  → 单 key 可串流量恒 ≤ 已预扣量，改装客户端白嫖收益=0，想续流必须回来再 mint 再预扣。
//  - 结算：settledAt 条件原子认领做互斥闸门（同 InterpretSession 惯例），finalize/deduct/cron
//    各路径恰好释放一次预留；usage cron 按 /v1/usage-logs 回填真实串流时长并处理孤儿。

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import {
  releaseTranscriptionMinutes,
  reserveTranscriptionMinutesUpTo,
} from '@/lib/quota';

type StreamGrantDbClient = Prisma.TransactionClient;

const grantLogger = logger.child({ component: 'soniox-stream-grant' });

/**
 * D：单次签发的预扣分钟数 = 单连接串流硬上限（分钟）。
 * 权衡：越大预扣占用户额度越久（FREE 60min/月，15 占 1/4，收尾即退）；越小长录音重连越频繁
 * （客户端在到点前主动平滑轮换，见 useSoniox/useInterpret）。Soniox 侧 max_session_duration_seconds
 * 合法域 1–18000s，15min 远在域内。ADMIN 同样按 D 发 key（重连无感），只是不预扣。
 */
export const STREAM_GRANT_MAX_MINUTES = 15;

/**
 * 活跃 grant 判定窗：mintedAt 距今不超过 key TTL(60s) + 连接上限 + 2min 时钟余量的未结 grant
 * 视为「可能仍在串流」。并发上限按它数（过窗的未结 grant 是孤儿，交给 usage cron，不占并发）。
 */
export const STREAM_GRANT_ACTIVE_WINDOW_MS =
  (STREAM_GRANT_MAX_MINUTES * 60 + 60 + 120) * 1000;

export type StreamGrantKind = 'realtime' | 'interpret';

export interface CreateStreamGrantInput {
  userId: string;
  kind: StreamGrantKind;
  /** realtime：关联的 Session.id（finalize 结算键）。 */
  sessionId?: string | null;
  /** interpret：关联的 InterpretSession.id（deduct/cron 结算键）。 */
  interpretSessionId?: string | null;
  /** 实际签发使用的 Soniox 区域（usage-logs 按区归属）。 */
  region: string;
  /**
   * L19：并发在途 grant 数上限（= maxConcurrentSessions*2+1，由调用方按用户组解析）。
   * 传入即在**预扣同一事务内**复核，`countActiveStreamGrants` 那种「读完再建行」的
   * check-then-act 近似检查挡不住并发脚本瞬时越闸。不传则不做流数限制（保持旧行为）。
   */
  maxActiveGrants?: number;
}

export type CreateStreamGrantResult =
  | {
      ok: true;
      grantId: string;
      /** 实际预扣分钟（ADMIN 为 0——不占额度，但连接上限仍按 D）。 */
      reservedMinutes: number;
      /** 下发给 Soniox 的单连接时长上限（秒）＝可串流量上限。 */
      maxSessionSeconds: number;
    }
  | {
      ok: false;
      reason: 'quota_exhausted' | 'user_not_found' | 'too_many_streams';
    };

/**
 * L19：并发流数闸命中时用来**回滚已做的预扣**的哨兵异常。
 * 关键点：Prisma 的 `$transaction(cb)` 只有在 cb **抛出**时才回滚；正常 return 一律提交。
 * 而这一步的预扣（reserveTranscriptionMinutesUpTo）已经写进了 used，直接 return 会留下一笔
 * 谁也不会释放的悬挂预留（比它要修的 bug 更糟）。故必须抛出、在事务外翻译成返回值。
 * 对照：`user_not_found` / `quota_exhausted` 两条 return 是安全的 —— 那两种情形下预扣本来
 * 就没发生（返回 null / 预扣 0）。
 */
class TooManyStreamGrantsError extends Error {
  constructor() {
    super('too many concurrent stream grants');
    this.name = 'TooManyStreamGrantsError';
  }
}

/**
 * 原子「预扣 + 建 grant」。同一事务：收缩式预扣（reserveTranscriptionMinutesUpTo，FOR UPDATE）
 * 成功才落 grant 行；额度剩 0 返回 quota_exhausted（调用方 403 拒发 key）。
 * 事务失败自然回滚预扣，无中间态。
 */
export async function createStreamGrantWithReservation(
  input: CreateStreamGrantInput
): Promise<CreateStreamGrantResult> {
  const activeSince = new Date(Date.now() - STREAM_GRANT_ACTIVE_WINDOW_MS);
  try {
    return await prisma.$transaction(async (tx) => {
      const reservation = await reserveTranscriptionMinutesUpTo(
        input.userId,
        STREAM_GRANT_MAX_MINUTES,
        tx
      );
      if (!reservation) {
        return { ok: false as const, reason: 'user_not_found' as const };
      }
      if (reservation.reservedMinutes <= 0) {
        return { ok: false as const, reason: 'quota_exhausted' as const };
      }

      // L19：并发流数闸放进**同一事务**。reserveTranscriptionMinutesUpTo 上面已经对该用户行
      // 做了 `SELECT ... FOR UPDATE`，同一用户的并发 mint 到这里已被串行化，因此「数一遍 +
      // 建行」是原子的。路由里那道 countActiveStreamGrants 预检仍保留（快速失败 + 429 文案），
      // 但它是读完再建行的 check-then-act 近似值：脚本并发发 N 个请求可以全部读到同一个旧
      // 计数、集体越过 maxConcurrent*2+1。这里才是真正生效的闸。
      if (input.maxActiveGrants != null && input.maxActiveGrants > 0) {
        const activeCount = await tx.sonioxStreamGrant.count({
          where: {
            userId: input.userId,
            settledAt: null,
            mintedAt: { gte: activeSince },
          },
        });
        if (activeCount >= input.maxActiveGrants) {
          throw new TooManyStreamGrantsError();
        }
      }

      const isAdmin = reservation.role === 'ADMIN';
      // ADMIN 不写 used（reserveUpTo 短路未扣），reservedMinutes 记 0 保证结算释放 0、对账不虚；
      // 连接上限仍按请求值全额（无限额用户没有收缩语义）。
      const reservedMinutes = isAdmin ? 0 : reservation.reservedMinutes;
      const maxSessionSeconds = reservation.reservedMinutes * 60;

      const grant = await tx.sonioxStreamGrant.create({
        data: {
          userId: input.userId,
          kind: input.kind,
          sessionId: input.sessionId ?? null,
          interpretSessionId: input.interpretSessionId ?? null,
          region: input.region,
          reservedMinutes,
          maxSessionSeconds,
        },
        select: { id: true },
      });

      return {
        ok: true as const,
        grantId: grant.id,
        reservedMinutes,
        maxSessionSeconds,
      };
    });
  } catch (err) {
    // L19：闸命中 —— 事务已回滚（预扣未提交），翻译成正常返回值交给调用方回 429。
    // 其它异常原样上抛（调用方的 catch 会 500 并作废 interpret 锚点）。
    if (err instanceof TooManyStreamGrantsError) {
      return { ok: false as const, reason: 'too_many_streams' as const };
    }
    throw err;
  }
}

/** 结算键：按 grant 自身 / 所属 Session / 所属 InterpretSession 圈定未结 grants。 */
export type StreamGrantSettleKey =
  | { grantId: string }
  | { sessionId: string }
  | { interpretSessionId: string };

export type StreamGrantSettledBy =
  | 'session_finalize'
  | 'interpret_deduct'
  | 'interpret_cron'
  | 'usage_cron'
  | 'usage_refund'
  | 'mint_failed';

export interface SettleStreamGrantsResult {
  /** 本次真正认领结算的 grant 数（0=都已被别的路径结算或不存在）。 */
  settledCount: number;
  /** 本次释放的预留分钟合计（月度重置已清零的按 0 释放）。 */
  releasedMinutes: number;
  /** 被结算 grants 已回填的 usage-logs 实测毫秒合计（未回填计 0，审计/口径参考）。 */
  actualMsTotal: number;
}

/**
 * 原子结算一组未结 grants：FOR UPDATE 锁行 → 置 settledAt/settledBy → 释放预留（恰好一次）。
 *
 * 互斥语义同 settleReservation/InterpretSession：并发的多条结算路径（finalize / deduct /
 * interpret-cron / usage-cron）只有第一个锁到未结行的能释放，其余读到 settledAt 非空 → 0。
 * 释放读的是**行上当前的 reservedMinutes**：月度重置可能已把它清零（预留随 used 归零作废），
 * 此时释放 0，不吃掉新周期额度。
 *
 * @param db 传入外层 $transaction 的 tx，使「结算 grants ⟺ 调用方的扣费/状态迁移」原子提交；
 *   默认自开事务保证 FOR UPDATE 生效。
 */
export async function settleStreamGrants(
  key: StreamGrantSettleKey,
  settledBy: StreamGrantSettledBy,
  db: StreamGrantDbClient = prisma
): Promise<SettleStreamGrantsResult> {
  const run = async (tx: StreamGrantDbClient): Promise<SettleStreamGrantsResult> => {
    const condition =
      'grantId' in key
        ? Prisma.sql`id = ${key.grantId}`
        : 'sessionId' in key
          ? Prisma.sql`sessionId = ${key.sessionId}`
          : Prisma.sql`interpretSessionId = ${key.interpretSessionId}`;

    const rows = await tx.$queryRaw<
      Array<{ id: string; userId: string; reservedMinutes: number; actualMs: number | null }>
    >(
      Prisma.sql`
        SELECT id, userId, reservedMinutes, actualMs
        FROM SonioxStreamGrant
        WHERE ${condition} AND settledAt IS NULL
        FOR UPDATE
      `
    );
    if (rows.length === 0) {
      return { settledCount: 0, releasedMinutes: 0, actualMsTotal: 0 };
    }

    const ids = rows.map((r) => r.id);
    const settled = await tx.sonioxStreamGrant.updateMany({
      where: { id: { in: ids }, settledAt: null },
      data: { settledAt: new Date(), settledBy },
    });

    // FOR UPDATE 已锁定这些行，count 必等于 ids.length；仍以实际 count 为准（纵深防御）。
    const releasedMinutes = rows.reduce(
      (total, r) => total + Math.max(0, Number(r.reservedMinutes) || 0),
      0
    );
    const actualMsTotal = rows.reduce(
      (total, r) => total + Math.max(0, Number(r.actualMs) || 0),
      0
    );
    if (settled.count > 0 && releasedMinutes > 0) {
      // 同一结算键下的 grants 恒属同一 user（键即用户内实体），合并一次释放。
      await releaseTranscriptionMinutes(rows[0].userId, releasedMinutes, tx);
    }
    return { settledCount: settled.count, releasedMinutes, actualMsTotal };
  };

  const maybeClient = db as unknown as { $transaction?: typeof prisma.$transaction };
  if (typeof maybeClient.$transaction === 'function') {
    return maybeClient.$transaction(run);
  }
  return run(db);
}

/**
 * 并发在途 grant 数（mint 并发上限护栏用）：未结且仍在活跃窗内的 grant。
 * 近似计数即可（真正的量闸是预扣本身），无需加锁。
 */
export async function countActiveStreamGrants(
  userId: string,
  now: Date = new Date()
): Promise<number> {
  return prisma.sonioxStreamGrant.count({
    where: {
      userId,
      settledAt: null,
      mintedAt: { gte: new Date(now.getTime() - STREAM_GRANT_ACTIVE_WINDOW_MS) },
    },
  });
}

/**
 * 某 Session 关联 grants 的 usage-logs 实测串流毫秒合计（含已结算的）。
 * finalize 自动回收(auto-reclaim)路径的时长口径来源之一：墙钟含挂机空闲被刻意忽略后，
 * Soniox 实测量是「真实产生了转录成本的量」，用它兜底可防「改装客户端只串流不回传内容、
 * 挂到 reclaim 按内容 0 分钟免单」。诚实用户正常收尾不走此口径，体验不变。
 */
export async function sumSessionGrantActualMs(sessionId: string): Promise<number> {
  const agg = await prisma.sonioxStreamGrant.aggregate({
    where: { sessionId, actualMs: { gt: 0 } },
    _sum: { actualMs: true },
  });
  return agg._sum.actualMs ?? 0;
}

/**
 * mint 失败回滚：结算刚建的 grant（释放预扣），settledBy='mint_failed'。
 * best-effort：失败仅告警——留给 usage cron 兜底（无 usage 记录 → usage_refund 退预扣）。
 */
export async function rollbackStreamGrant(grantId: string): Promise<void> {
  try {
    await settleStreamGrants({ grantId }, 'mint_failed');
  } catch (err) {
    grantLogger.warn(
      { grantId, message: err instanceof Error ? err.message : String(err) },
      'failed to rollback stream grant after mint failure; usage cron will refund'
    );
  }
}
