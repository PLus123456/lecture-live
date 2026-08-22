import 'server-only';

import type { Prisma, UserRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logSystemEvent } from '@/lib/auditLog';
import { logger } from '@/lib/logger';
import type { PaymentProviderName } from '@/lib/payment/types';

/**
 * 退款 / 拒付 / 争议的反向处理（P3-16）。
 *
 * 在此之前整条链路对「钱被拿回去了」零实现：网关退款、用户拒付、争议裁定，我方订单一律
 * 停在 paid，权益照留 —— 只出不进的单向阀。这里补上另一半：
 *  1. 订单 CAS `paid → refunded` 并写 `refundedAt`（幂等：重复通知第二次 count=0）；
 *  2. 冻结权益 —— 退回到账余额（地板 0）、回收永久分钟池、缩回/撤销会员期；
 *  3. 记 `refund` 台账（枚举本就存在但一直没有 writer）+ 告警审计事件。
 *
 * 刻意**不做**的事：不追缴用户已经消费掉的额度。余额被花光时扣到 0 为止，差额记在台账里
 * 供人工追。把余额打成负数会污染所有 `gte` 守卫（见 P3-17 同款教训）。
 */

export type ReversalOutcome =
  | 'reversed' // 本次成功反向
  | 'already' // 已反向过（幂等重复通知）
  | 'not_paid' // 订单不在 paid 态（pending/failed…）→ 没有权益可冻结
  | 'unknown_order'; // 找不到订单（含拒付通知拿不到我方订单号）

export interface ReversalResult {
  /** 是否可以给网关回成功 ACK。false 才让网关重试（仅限我方处理异常）。 */
  handled: boolean;
  outcome: ReversalOutcome;
}

export interface ReversalInput {
  outTradeNo: string;
  provider: PaymentProviderName;
  /** 网关原始事件串（审计）。 */
  rawStatus?: string;
  /** 网关侧退款/争议单号（审计）。 */
  providerRef?: string;
}

interface OrderGrantMeta {
  creditCents?: number;
  grant?: {
    kind?: 'membership' | 'minutes';
    durationDays?: number | null;
    grantMinutes?: number | null;
    tierId?: string | null;
    tierName?: string;
  };
}

function parseMeta(json: string | null): OrderGrantMeta {
  if (!json) return {};
  try {
    return JSON.parse(json) as OrderGrantMeta;
  } catch {
    return {};
  }
}

export async function handlePaymentReversal(
  input: ReversalInput
): Promise<ReversalResult> {
  const { outTradeNo, provider } = input;
  const tag = `provider=${provider} outTradeNo=${outTradeNo || '(unknown)'} event=${input.rawStatus ?? ''}`;

  // 拒付事件的 data.object 是 Dispute，通常带不出我方订单号 → 无法自动处理，必须告警到人。
  if (!outTradeNo) {
    alertReversal('recharge.reversal.unresolved', tag);
    return { handled: true, outcome: 'unknown_order' };
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const order = await tx.paymentOrder.findUnique({ where: { outTradeNo } });
      if (!order) return 'unknown_order' as const;

      // CAS：只有 paid 且未反向过的订单可以被反向。重复通知第二次 count=0 → 幂等。
      const claim = await tx.paymentOrder.updateMany({
        where: { outTradeNo, status: 'paid', refundedAt: null, provider },
        data: { status: 'refunded', refundedAt: new Date() },
      });
      if (claim.count === 0) {
        return order.refundedAt || order.status === 'refunded'
          ? ('already' as const)
          : ('not_paid' as const);
      }

      const meta = parseMeta(order.metadataJson);
      await freezeEntitlements(tx, order.userId, order.id, order.amountCents, meta);
      return 'reversed' as const;
    });

    if (outcome === 'reversed') {
      alertReversal('recharge.reversal.applied', tag);
    } else if (outcome === 'unknown_order') {
      alertReversal('recharge.reversal.unknown_order', tag);
    } else if (outcome === 'not_paid') {
      alertReversal('recharge.reversal.not_paid', tag);
    }
    return { handled: true, outcome };
  } catch (err) {
    // 我方处理失败 → 不回成功 ACK，让网关重投（退款事件重投是安全的：CAS 幂等）。
    logger.error({ err, outTradeNo, provider }, '支付反向处理失败');
    logSystemEvent('recharge.reversal.failed', tag);
    return { handled: false, outcome: 'not_paid' };
  }
}

/**
 * 事务内冻结权益。三条线各自地板保护，绝不打成负数：
 *  - 余额：扣回到账额，`GREATEST(0, …)`（与 wallet.ts 时长路径同款防护）；
 *  - 永久分钟池：回收本单赠送的分钟，同样地板 0；
 *  - 会员：按本单天数缩回到期日，缩到过去就回落 originalRole 并 bump tokenVersion 踢旧 JWT。
 */
async function freezeEntitlements(
  tx: Prisma.TransactionClient,
  userId: string,
  orderId: string,
  amountCents: number,
  meta: OrderGrantMeta
): Promise<void> {
  // M6 锁读（与 wallet.ts applyGrantTx 的 P3-6 同款 idiom）：余额与分钟池两条线走的是
  // `GREATEST(0, col - n)` 相对更新，本就并发安全；但**会员分支是读-改-写绝对值**
  // （roleExpiresAt = 快照到期日 − 本单天数），快照读在并发下必然 lost update：
  //  ① 同一用户两笔订单同时退款 → 都基于同一份快照算，后写覆盖先写，只缩回一期，
  //     另一笔已退款的会员期被白留（平台资损）；
  //  ② 退款与余额购买并发 → freeze 在购买提交前读快照、提交后写回，刚买的 30 天被抹掉、
  //     或 originalRole 被错误清空（用户资损）。
  // FOR UPDATE 让第二笔排在第一笔提交之后再读，两笔各缩一期。锁顺序与 applyGrantTx 一致
  // （PaymentOrder → User），不引入新的死锁环。
  const rows = await tx.$queryRaw<
    Array<{
      walletBalanceCents: number;
      purchasedMinutesBalance: number;
      role: UserRole;
      originalRole: UserRole | null;
      roleExpiresAt: Date | string | null;
    }>
  >`
    SELECT walletBalanceCents, purchasedMinutesBalance, role, originalRole, roleExpiresAt
    FROM User WHERE id = ${userId} FOR UPDATE
  `;
  const row = rows?.[0];
  if (!row) return;
  const user = {
    walletBalanceCents: Number(row.walletBalanceCents),
    purchasedMinutesBalance: Number(row.purchasedMinutesBalance),
    role: row.role,
    originalRole: row.originalRole,
    roleExpiresAt: row.roleExpiresAt ? new Date(row.roleExpiresAt) : null,
  };

  // 1) 余额：退回本单到账额（topup 可能含赠送 → 按 creditCents）。
  const creditCents = Math.max(0, Math.round(meta.creditCents ?? amountCents));
  if (creditCents > 0) {
    await tx.$executeRaw`
      UPDATE User
      SET walletBalanceCents = GREATEST(0, walletBalanceCents - ${creditCents})
      WHERE id = ${userId}
    `;
  }
  const after = await tx.user.findUnique({
    where: { id: userId },
    select: { walletBalanceCents: true },
  });
  const balanceAfter = after?.walletBalanceCents ?? user.walletBalanceCents;

  // 2) 权益本体。
  const grant = meta.grant;
  let minutesDelta: number | null = null;
  if (grant?.kind === 'minutes') {
    const minutes = Math.max(0, grant.grantMinutes ?? 0);
    if (minutes > 0) {
      await tx.$executeRaw`
        UPDATE User
        SET purchasedMinutesBalance = GREATEST(0, purchasedMinutesBalance - ${minutes})
        WHERE id = ${userId}
      `;
      minutesDelta = -minutes;
    }
  } else if (grant?.kind === 'membership') {
    // ADMIN 永不降级（applyGrantTx 本就拒绝给 ADMIN 卖会员，但退款时角色可能已变）。
    if (user.role !== 'ADMIN') {
      const days = Math.max(1, grant.durationDays ?? 30);
      const now = new Date();
      const shrunk = user.roleExpiresAt
        ? new Date(user.roleExpiresAt.getTime() - days * 86_400_000)
        : null;
      const fallback: UserRole = user.originalRole ?? 'FREE';
      if (!shrunk || shrunk <= now) {
        await tx.user.update({
          where: { id: userId },
          data: {
            role: fallback,
            originalRole: null,
            roleExpiresAt: null,
            tokenVersion: { increment: 1 },
          },
        });
      } else {
        await tx.user.update({
          where: { id: userId },
          data: { roleExpiresAt: shrunk, tokenVersion: { increment: 1 } },
        });
      }
    }
  }

  // 3) 台账（`refund` 枚举终于有了 writer）。金额记负数 = 出账。
  await tx.walletTransaction.create({
    data: {
      userId,
      type: 'refund',
      amountCents: -creditCents,
      balanceAfterCents: balanceAfter,
      minutesDelta,
      orderId,
      tierId: grant?.tierId ?? null,
      note: `退款/拒付冲正${grant?.tierName ? `（${grant.tierName}）` : ''}`,
    },
  });
}

/** 反向事件一律既进审计流水（admin 可见）又进日志（值班可见）——这是 P3-16 要求的「告警」。 */
function alertReversal(action: string, detail: string): void {
  logSystemEvent(action, detail);
  logger.warn({ action, detail }, '收到支付反向通知');
}
