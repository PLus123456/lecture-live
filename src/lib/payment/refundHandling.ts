import 'server-only';

import type { Prisma, UserRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logSystemEvent } from '@/lib/auditLog';
import { logger } from '@/lib/logger';
import type {
  PaymentProviderMode,
  PaymentProviderName,
} from '@/lib/payment/types';
import { resolveRoleQuotas, resolveRoleStorageBytesLimit } from '@/lib/userRoles';
import { settlePoolOnLimitChange } from '@/lib/quota';
import {
  lockFundingAllocations,
  lockFundingLotForOrder,
  markFundingAllocationReversed,
  markFundingLotReversed,
  recordPaymentDebtAndHold,
  recordPaymentHold,
} from '@/lib/payment/fundingLedger';
import { isPurchasableMembershipRole } from '@/lib/payment/tierPolicy';

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
  | 'review' // 历史订单缺少可证明的 entitlement/source，必须人工处理
  | 'partial_review' // 部分/金额不明反向：冻结后人工处置，绝不整单撤权
  | 'superseded' // 旧 pending 事件晚于该资源的 durable terminal 事实到达
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
  reversalAmountCents?: number;
  fullReversal?: boolean;
  reversalState?: 'pending' | 'withdrawn' | 'reinstated';
  providerMode?: PaymentProviderMode;
  providerAccount?: string;
  sourceObjectType?: 'refund' | 'dispute';
  sourceObjectId?: string;
  occurredAt?: Date;
  currency?: string;
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

interface LockedReversalOrder {
  id: string;
  userId: string;
  provider: string;
  kind: string;
  outTradeNo: string;
  amountCents: number;
  currency: string;
  status: string;
  refundedAt: Date | string | null;
  fulfillmentStatus: string;
  reviewReason: string | null;
  metadataJson: string | null;
}

interface LockedReversalUser {
  walletBalanceCents: number;
  purchasedMinutesBalance: number;
  role: UserRole;
  originalRole: UserRole | null;
  roleExpiresAt: Date | string | null;
  transcriptionMinutesLimit: number;
}

interface EntitlementRow {
  id: string;
  userId: string;
  kind: string;
  grantRole: string | null;
  totalUnits: number;
  revokedUnits: number;
  status: string;
  grantedAt: Date | string;
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

  // Route should resolve Stripe objects through the durable mapping before reaching this helper.
  if (!outTradeNo) {
    alertReversal('recharge.reversal.unresolved', tag);
    return { handled: false, outcome: 'unknown_order' };
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const orders = await tx.$queryRaw<LockedReversalOrder[]>`
        SELECT id, userId, provider, kind, outTradeNo, amountCents, currency, status,
               refundedAt, fulfillmentStatus, reviewReason, metadataJson
        FROM PaymentOrder WHERE outTradeNo = ${outTradeNo} FOR UPDATE
      `;
      const order = orders[0];
      if (!order) return 'unknown_order' as const;
      if (order.provider !== provider) return 'unknown_order' as const;

      if (order.refundedAt || order.status === 'refunded') {
        return order.fulfillmentStatus === 'review'
          ? ('review' as const)
          : ('already' as const);
      }

      const reversalAmount = input.reversalAmountCents;
      const strictStripeEvidence =
        provider === 'stripe' && Boolean(input.rawStatus?.trim());
      const stripeEvidenceComplete =
        !strictStripeEvidence ||
        (Number.isSafeInteger(reversalAmount) &&
          (reversalAmount ?? 0) > 0 &&
          Boolean(input.currency?.trim()));
      const amountIsBounded =
        stripeEvidenceComplete &&
        (reversalAmount === undefined ||
          (Number.isSafeInteger(reversalAmount) && reversalAmount > 0));
      const isFullAmount =
        reversalAmount === undefined || reversalAmount === Number(order.amountCents);
      const currencyMatches =
        !input.currency ||
        input.currency.trim().toUpperCase() === order.currency.trim().toUpperCase();
      const stripeRefundProvesFull =
        !strictStripeEvidence ||
        !input.rawStatus?.includes('charge.refunded') ||
        input.fullReversal === true;
      if (
        !amountIsBounded ||
        input.fullReversal === false ||
        !stripeRefundProvesFull ||
        !isFullAmount ||
        !currencyMatches
      ) {
        // Do not subtract aggregate wallet/entitlement state proportionally: the current funding
        // schema records whole-source reversals, so guessing here would either over-revoke a
        // one-cent refund or make later cumulative refunds double-revoke. Freeze mutations and
        // retain a durable review event instead.
        const users = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM User WHERE id = ${order.userId} FOR UPDATE
        `;
        if (!users[0]) return 'review' as const;
        if (
          provider === 'stripe' &&
          input.reversalState === 'pending' &&
          input.providerMode &&
          input.providerAccount &&
          input.sourceObjectType &&
          input.sourceObjectId &&
          input.occurredAt instanceof Date &&
          Number.isFinite(input.occurredAt.getTime())
        ) {
          // Persisted terminal facts win over an older pending delivery. This query runs under the
          // same Order -> User locks used by terminal settlement, closing both arrival orders:
          // pending first is released by terminal; terminal first makes late pending a no-op.
          const terminalRows = await tx.$queryRaw<Array<{ payloadJson: string }>>`
            SELECT payloadJson FROM PaymentWebhookEvent
            WHERE provider = 'stripe'
              AND providerMode = ${input.providerMode}
              AND providerAccount = ${input.providerAccount}
              AND objectType = ${input.sourceObjectType}
              AND objectId = ${input.sourceObjectId}
              AND JSON_UNQUOTE(JSON_EXTRACT(payloadJson, '$.reversalState'))
                    IN ('withdrawn', 'reinstated')
            ORDER BY id FOR UPDATE
          `;
          const pendingOccurredAt = input.occurredAt.getTime();
          const superseded = terminalRows.some((row) => {
            try {
              const payload = JSON.parse(row.payloadJson) as { occurredAt?: unknown };
              return (
                typeof payload.occurredAt === 'string' &&
                Number.isFinite(new Date(payload.occurredAt).getTime()) &&
                new Date(payload.occurredAt).getTime() >= pendingOccurredAt
              );
            } catch {
              return false;
            }
          });
          if (superseded) return 'superseded' as const;
        }
        const pendingStripeReason =
          provider === 'stripe' &&
          input.reversalState === 'pending' &&
          input.providerRef?.trim()
            ? `stripe_pending_reversal:${input.providerRef.trim()}`
            : 'partial_reversal_unsupported';
        await recordPaymentHold(tx, {
          userId: order.userId,
          sourceOrderId: order.id,
          reason: pendingStripeReason,
        });
        return 'partial_review' as const;
      }

      // A reversal can arrive before the settlement webhook. If the durable fulfillment state
      // proves that no wallet credit or entitlement was ever committed, terminalize the order
      // under the same order lock now. ACKing it as a mere `not_paid` no-op would lose the
      // reversal and allow a later paid delivery to grant rights. Review/processing states whose
      // provenance is not explicit remain retryable instead of being guessed.
      const provablyUnfulfilled =
        (order.fulfillmentStatus === 'pending' &&
          ['pending', 'expired', 'failed', 'canceled'].includes(order.status)) ||
        (order.fulfillmentStatus === 'review' &&
          ((order.status === 'late_paid' && order.reviewReason === 'payment_after_expiry') ||
            order.reviewReason === 'payment_before_order' ||
            order.reviewReason === 'fulfillment_failed_uncommitted'));
      if (provablyUnfulfilled) {
        await tx.$executeRaw`
          UPDATE PaymentOrder
          SET status = 'refunded', refundedAt = NOW(3),
              providerRef = COALESCE(${input.providerRef ?? null}, providerRef),
              fulfillmentStatus = 'reversed', fulfillmentError = NULL
          WHERE id = ${order.id} AND refundedAt IS NULL
            AND fulfillmentStatus IN ('pending', 'review')
        `;
        return 'reversed' as const;
      }
      if (
        order.status === 'paid' &&
        order.fulfillmentStatus === 'review' &&
        order.reviewReason === 'legacy_fulfillment_unresolved'
      ) {
        const users = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM User WHERE id = ${order.userId} FOR UPDATE
        `;
        if (!users[0]) return 'review' as const;
        const meta = parseMeta(order.metadataJson);
        await recordPaymentDebtAndHold(tx, {
          userId: order.userId,
          sourceOrderId: order.id,
          amountCents: Math.max(0, Math.round(meta.creditCents ?? order.amountCents)),
          reason: 'legacy_source_unresolved',
        });
        await tx.$executeRaw`
          UPDATE PaymentOrder
          SET status = 'refunded', refundedAt = NOW(3),
              fulfillmentStatus = 'review',
              reviewReason = 'reversal_provenance_unresolved',
              fulfillmentError = 'legacy paid purchase may retain unattributed wallet credit'
          WHERE id = ${order.id} AND status = 'paid'
        `;
        return 'review' as const;
      }
      if (order.status !== 'paid' || order.fulfillmentStatus !== 'fulfilled') {
        return 'not_paid' as const;
      }

      // Global lock order matches fulfillment: PaymentOrder -> User -> entitlement/source rows.
      const users = await tx.$queryRaw<LockedReversalUser[]>`
        SELECT walletBalanceCents, purchasedMinutesBalance, role, originalRole, roleExpiresAt,
               transcriptionMinutesLimit
        FROM User WHERE id = ${order.userId} FOR UPDATE
      `;
      const user = users[0];
      if (!user) return 'review' as const;

      const meta = parseMeta(order.metadataJson);
      const reversible = await freezeEntitlements(
        tx,
        order,
        {
          ...user,
          walletBalanceCents: Number(user.walletBalanceCents),
          purchasedMinutesBalance: Number(user.purchasedMinutesBalance),
          roleExpiresAt: user.roleExpiresAt ? new Date(user.roleExpiresAt) : null,
        },
        meta
      );
      if (!reversible) {
        await tx.$executeRaw`
          UPDATE PaymentOrder
          SET status = 'refunded', refundedAt = NOW(3), fulfillmentStatus = 'review',
              reviewReason = 'reversal_provenance_unresolved',
              fulfillmentError = 'legacy entitlement/source unresolved'
          WHERE id = ${order.id}
        `;
        return 'review' as const;
      }
      await tx.$executeRaw`
        UPDATE PaymentOrder
        SET status = 'refunded', refundedAt = NOW(3), fulfillmentStatus = 'reversed',
            fulfillmentError = NULL
        WHERE id = ${order.id} AND status = 'paid'
      `;
      return 'reversed' as const;
    });

    if (outcome === 'reversed') {
      alertReversal('recharge.reversal.applied', tag);
    } else if (outcome === 'unknown_order') {
      alertReversal('recharge.reversal.unknown_order', tag);
    } else if (outcome === 'not_paid') {
      alertReversal('recharge.reversal.not_paid', tag);
    }
    return {
      handled:
        outcome === 'reversed' || outcome === 'already' || outcome === 'superseded',
      outcome,
    };
  } catch (err) {
    // 我方处理失败 → 不回成功 ACK，让网关重投（退款事件重投是安全的：CAS 幂等）。
    logger.error({ err, outTradeNo, provider }, '支付反向处理失败');
    logSystemEvent('recharge.reversal.failed', tag);
    return { handled: false, outcome: 'not_paid' };
  }
}

/** Follow one rejected funding lot into every downstream allocation. */
async function freezeEntitlements(
  tx: Prisma.TransactionClient,
  order: LockedReversalOrder,
  user: LockedReversalUser & { roleExpiresAt: Date | null },
  meta: OrderGrantMeta
): Promise<boolean> {
  const userId = order.userId;
  const orderId = order.id;
  const lot = await lockFundingLotForOrder(tx, orderId);
  if (!lot) {
    // Historical aggregate balances cannot be attributed safely. Freeze + debt + human review;
    // never guess by subtracting the whole order from whatever wallet happens to remain today.
    await recordPaymentDebtAndHold(tx, {
      userId,
      sourceOrderId: orderId,
      amountCents: Math.max(0, Math.round(meta.creditCents ?? order.amountCents)),
      reason: 'legacy_source_unresolved',
    });
    return false;
  }
  if (lot.status === 'reversed') return true;
  if (lot.status !== 'active') return false;

  const allocations = await lockFundingAllocations(tx, lot.id);
  const expectedOriginalCents = Math.max(
    0,
    Math.round(meta.creditCents ?? order.amountCents)
  );
  const originalCents = Number(lot.originalCents);
  const lotRemaining = Number(lot.remainingCents);
  const walletBalanceCents = Number(user.walletBalanceCents);
  const purchasedMinutesBalance = Number(user.purchasedMinutesBalance);
  const allocatedCents = allocations.reduce(
    (sum, allocation) => sum + Math.max(0, Number(allocation.amountCents)),
    0
  );

  // The source ledger is a security boundary, not a best-effort hint. Validate its conservation
  // equation and ownership before changing any balance or entitlement. If rows were created by an
  // older build, partially deleted, or corrupted, quarantine the order and freeze the account for
  // human reconciliation instead of guessing which user's money/rights to take.
  const structurallyInvalid =
    lot.userId !== userId ||
    !Number.isSafeInteger(walletBalanceCents) ||
    !Number.isSafeInteger(purchasedMinutesBalance) ||
    walletBalanceCents < 0 ||
    purchasedMinutesBalance < 0 ||
    !Number.isSafeInteger(originalCents) ||
    !Number.isSafeInteger(lotRemaining) ||
    originalCents < 0 ||
    lotRemaining < 0 ||
    lotRemaining > originalCents ||
    originalCents !== expectedOriginalCents ||
    allocations.some(
      (allocation) =>
        allocation.fundingLotId !== lot.id ||
        allocation.userId !== userId ||
        !Number.isSafeInteger(Number(allocation.amountCents)) ||
        Number(allocation.amountCents) <= 0 ||
        !Number.isSafeInteger(Number(allocation.entitlementUnits)) ||
        Number(allocation.entitlementUnits) < 0 ||
        !Number.isSafeInteger(Number(allocation.recoveredUnits)) ||
        Number(allocation.recoveredUnits) !== 0 ||
        !Number.isSafeInteger(Number(allocation.debtCents)) ||
        Number(allocation.debtCents) !== 0 ||
        allocation.reversedAt !== null ||
        !['membership', 'minutes', 'service', 'admin'].includes(allocation.targetKind)
    ) ||
    allocatedCents !== originalCents - lotRemaining;
  if (structurallyInvalid) {
    await recordPaymentDebtAndHold(tx, {
      userId,
      sourceOrderId: orderId,
      sourceLotId: lot.id,
      amountCents: expectedOriginalCents,
      reason: 'funding_provenance_invalid',
    });
    return false;
  }

  // Lock and validate every linked entitlement before the first mutation. A missing/cross-user
  // link is not equivalent to "already consumed": it means provenance is unverifiable and must be
  // reviewed. Keeping this preflight mutation-free prevents a half-automatic, half-manual reverse.
  const entitlements = new Map<string, EntitlementRow>();
  for (const allocation of allocations) {
    if (allocation.targetKind !== 'membership' && allocation.targetKind !== 'minutes') continue;
    if (!allocation.entitlementId || Number(allocation.entitlementUnits) <= 0) {
      await recordPaymentDebtAndHold(tx, {
        userId,
        sourceOrderId: orderId,
        sourceLotId: lot.id,
        amountCents: expectedOriginalCents,
        reason: 'funding_provenance_invalid',
      });
      return false;
    }
    const rows = await tx.$queryRaw<EntitlementRow[]>`
      SELECT id, userId, kind, grantRole, totalUnits, revokedUnits, status, grantedAt
      FROM PaymentEntitlement WHERE id = ${allocation.entitlementId} FOR UPDATE
    `;
    const entitlement = rows[0];
    if (
      !entitlement ||
      entitlement.userId !== userId ||
      entitlement.kind !== allocation.targetKind ||
      !Number.isSafeInteger(Number(entitlement.totalUnits)) ||
      !Number.isSafeInteger(Number(entitlement.revokedUnits)) ||
      Number(entitlement.totalUnits) <= 0 ||
      Number(entitlement.revokedUnits) < 0 ||
      Number(entitlement.revokedUnits) > Number(entitlement.totalUnits) ||
      Number(allocation.entitlementUnits) >
        Number(entitlement.totalUnits) - Number(entitlement.revokedUnits) ||
      (entitlement.kind === 'membership' &&
        !isPurchasableMembershipRole(entitlement.grantRole)) ||
      !['active', 'partially_reversed'].includes(entitlement.status)
    ) {
      await recordPaymentDebtAndHold(tx, {
        userId,
        sourceOrderId: orderId,
        sourceLotId: lot.id,
        amountCents: expectedOriginalCents,
        reason: 'funding_provenance_invalid',
      });
      return false;
    }
    entitlements.set(allocation.id, entitlement);
  }

  const membershipAllocations = allocations.filter(
    (allocation) =>
      allocation.targetKind === 'membership' &&
      allocation.entitlementId &&
      Number(allocation.entitlementUnits) > 0
  );
  const membershipEntitlements =
    membershipAllocations.length > 0
      ? await tx.$queryRaw<EntitlementRow[]>`
          SELECT id, userId, kind, grantRole, totalUnits, revokedUnits, status, grantedAt
          FROM PaymentEntitlement
          WHERE userId = ${userId} AND kind = 'membership'
            AND status IN ('active', 'partially_reversed')
          ORDER BY grantedAt, id
          FOR UPDATE
        `
      : [];
  const membershipById = new Map(membershipEntitlements.map((row) => [row.id, row]));
  if (
    membershipAllocations.some(
      (allocation) =>
        !allocation.entitlementId || !membershipById.has(allocation.entitlementId)
    ) ||
    membershipEntitlements.some(
      (entitlement) =>
        entitlement.userId !== userId ||
        entitlement.kind !== 'membership' ||
        !isPurchasableMembershipRole(entitlement.grantRole) ||
        !Number.isSafeInteger(Number(entitlement.totalUnits)) ||
        !Number.isSafeInteger(Number(entitlement.revokedUnits)) ||
        Number(entitlement.totalUnits) <= 0 ||
        Number(entitlement.revokedUnits) < 0 ||
        Number(entitlement.revokedUnits) > Number(entitlement.totalUnits)
    )
  ) {
    await recordPaymentDebtAndHold(tx, {
      userId,
      sourceOrderId: orderId,
      sourceLotId: lot.id,
      amountCents: expectedOriginalCents,
      reason: 'funding_provenance_invalid',
    });
    return false;
  }

  const mutableUser = {
    ...user,
    walletBalanceCents,
    purchasedMinutesBalance,
  };

  // Only the unspent remainder is still in the fungible wallet. Recover at most the current
  // non-negative balance; an accounting shortfall becomes debt rather than a negative wallet.
  const walletRecovered = Math.min(lotRemaining, mutableUser.walletBalanceCents);
  if (walletRecovered > 0) {
    const changed = await tx.$executeRaw`
      UPDATE User SET walletBalanceCents = walletBalanceCents - ${walletRecovered}
      WHERE id = ${userId} AND walletBalanceCents >= ${walletRecovered}
    `;
    if (Number(changed) !== 1) throw new Error('wallet reversal raced despite user row lock');
    mutableUser.walletBalanceCents -= walletRecovered;
  }

  let debtCents = lotRemaining - walletRecovered;
  let allocationRecoveredCents = 0;
  let recoveredMinutes = 0;
  const dayMs = 86_400_000;
  let membershipFutureMs =
    mutableUser.roleExpiresAt && mutableUser.role !== 'ADMIN'
      ? Math.max(0, mutableUser.roleExpiresAt.getTime() - Date.now())
      : 0;
  let membershipMsToRemove = 0;
  const membershipRevocations = new Map<string, number>();
  for (const allocation of allocations) {
    if (allocation.reversedAt) continue;
    const allocationCents = Math.max(0, Number(allocation.amountCents));
    const requestedUnits = Math.max(0, Number(allocation.entitlementUnits));
    let recoveredUnits = 0;
    let recoveredValueCents = 0;

    if (
      allocation.entitlementId &&
      requestedUnits > 0 &&
      (allocation.targetKind === 'membership' || allocation.targetKind === 'minutes')
    ) {
      const entitlement = entitlements.get(allocation.id);
      if (entitlement) {
        const stillAttributable = Math.max(
          0,
          Math.min(
            requestedUnits,
            Number(entitlement.totalUnits) - Number(entitlement.revokedUnits)
          )
        );
        if (entitlement.kind === 'minutes') {
          recoveredUnits = Math.min(stillAttributable, mutableUser.purchasedMinutesBalance);
          if (recoveredUnits > 0) {
            await tx.$executeRaw`
              UPDATE User
              SET purchasedMinutesBalance = purchasedMinutesBalance - ${recoveredUnits}
              WHERE id = ${userId} AND purchasedMinutesBalance >= ${recoveredUnits}
            `;
            mutableUser.purchasedMinutesBalance -= recoveredUnits;
            recoveredMinutes += recoveredUnits;
          }
          recoveredValueCents =
            requestedUnits > 0
              ? Math.floor((allocationCents * recoveredUnits) / requestedUnits)
              : 0;
        } else if (
          entitlement.kind === 'membership' &&
          mutableUser.role !== 'ADMIN' &&
          mutableUser.roleExpiresAt
        ) {
          const attributableMs = stillAttributable * dayMs;
          const recoveredMs = Math.min(attributableMs, membershipFutureMs);
          membershipFutureMs -= recoveredMs;
          membershipMsToRemove += attributableMs;
          membershipRevocations.set(
            entitlement.id,
            (membershipRevocations.get(entitlement.id) ?? 0) + requestedUnits
          );
          // Store only whole-day audit units, but value the actually removed fractional time in
          // cents. Ceil(days) would claim more value than was recovered and silently understate
          // debt by as much as one day.
          recoveredUnits = Math.floor(recoveredMs / dayMs);
          recoveredValueCents =
            requestedUnits > 0
              ? Math.floor(
                  (allocationCents * recoveredMs) / (requestedUnits * dayMs)
                )
              : 0;
        }

        const newRevoked = Math.min(
          Number(entitlement.totalUnits),
          Number(entitlement.revokedUnits) + requestedUnits
        );
        await tx.$executeRaw`
          UPDATE PaymentEntitlement
          SET revokedUnits = ${newRevoked},
              status = ${newRevoked >= Number(entitlement.totalUnits) ? 'reversed' : 'partially_reversed'},
              reversedAt = CASE WHEN ${newRevoked >= Number(entitlement.totalUnits)} THEN NOW(3) ELSE reversedAt END,
              updatedAt = NOW(3)
          WHERE id = ${entitlement.id}
        `;
      }
    }

    const recoveredCents = Math.min(allocationCents, recoveredValueCents);
    const allocationDebt = allocationCents - recoveredCents;
    allocationRecoveredCents += recoveredCents;
    debtCents += allocationDebt;
    await markFundingAllocationReversed(tx, {
      allocationId: allocation.id,
      recoveredUnits,
      debtCents: allocationDebt,
    });
  }

  if (
    membershipMsToRemove > 0 &&
    mutableUser.role !== 'ADMIN' &&
    mutableUser.roleExpiresAt
  ) {
    const now = new Date();
    const shrunk = new Date(mutableUser.roleExpiresAt.getTime() - membershipMsToRemove);
    const remainingMemberships = membershipEntitlements
      .map((entitlement) => ({
        entitlement,
        remainingUnits:
          Number(entitlement.totalUnits) -
          Number(entitlement.revokedUnits) -
          (membershipRevocations.get(entitlement.id) ?? 0),
      }))
      .filter((item) => item.remainingUnits > 0)
      .sort((left, right) => {
        const time =
          new Date(left.entitlement.grantedAt).getTime() -
          new Date(right.entitlement.grantedAt).getTime();
        return time || left.entitlement.id.localeCompare(right.entitlement.id);
      });
    const latest = remainingMemberships.at(-1)?.entitlement;
    const fallback: UserRole = mutableUser.originalRole ?? 'FREE';
    const desiredRole: UserRole =
      shrunk > now && latest && isPurchasableMembershipRole(latest.grantRole)
        ? latest.grantRole
        : fallback;
    const desiredExpiry = shrunk > now && latest ? shrunk : null;
    const [quotas, storageBytesLimit] = await Promise.all([
      resolveRoleQuotas(desiredRole),
      resolveRoleStorageBytesLimit(desiredRole),
    ]);
    if (
      mutableUser.purchasedMinutesBalance > 0 &&
      Number.isFinite(mutableUser.transcriptionMinutesLimit) &&
      quotas.transcriptionMinutesLimit < mutableUser.transcriptionMinutesLimit
    ) {
      await settlePoolOnLimitChange(
        userId,
        mutableUser.transcriptionMinutesLimit,
        quotas.transcriptionMinutesLimit,
        tx
      );
      const refreshedPool = await tx.user.findUnique({
        where: { id: userId },
        select: { purchasedMinutesBalance: true },
      });
      if (
        refreshedPool &&
        Number.isSafeInteger(refreshedPool.purchasedMinutesBalance) &&
        refreshedPool.purchasedMinutesBalance >= 0
      ) {
        mutableUser.purchasedMinutesBalance = refreshedPool.purchasedMinutesBalance;
      }
    }
    await tx.user.update({
      where: { id: userId },
      data: {
        role: desiredRole,
        originalRole: desiredExpiry ? mutableUser.originalRole : null,
        roleExpiresAt: desiredExpiry,
        customGroupId: null,
        transcriptionMinutesLimit: quotas.transcriptionMinutesLimit,
        storageHoursLimit: quotas.storageHoursLimit,
        allowedModels: quotas.allowedModels,
        storageBytesLimit,
        tokenVersion: { increment: 1 },
      },
    });
    mutableUser.role = desiredRole;
    mutableUser.originalRole = desiredExpiry ? mutableUser.originalRole : null;
    mutableUser.roleExpiresAt = desiredExpiry;
    mutableUser.transcriptionMinutesLimit = quotas.transcriptionMinutesLimit;
  }

  // Any historical/inconsistent gap inside a nominally tracked lot is debt, never silently lost.
  const recoveredCents = walletRecovered + allocationRecoveredCents;
  await markFundingLotReversed(tx, { lotId: lot.id, recoveredCents });
  if (debtCents > 0) {
    await recordPaymentDebtAndHold(tx, {
      userId,
      sourceOrderId: orderId,
      sourceLotId: lot.id,
      amountCents: debtCents,
      reason: 'chargeback_unrecovered',
    });
  }

  const grant = meta.grant;
  await tx.walletTransaction.create({
    data: {
      userId,
      type: 'refund',
      amountCents: walletRecovered === 0 ? 0 : -walletRecovered,
      balanceAfterCents: mutableUser.walletBalanceCents,
      minutesDelta: recoveredMinutes > 0 ? -recoveredMinutes : null,
      orderId,
      tierId: grant?.tierId ?? null,
      note: `退款/拒付来源追缴${grant?.tierName ? `（${grant.tierName}）` : ''}${
        debtCents > 0 ? `；未追回 ${debtCents} 分已记债务并冻结` : ''
      }`,
    },
  });
  return true;
}

/** 反向事件一律既进审计流水（admin 可见）又进日志（值班可见）——这是 P3-16 要求的「告警」。 */
function alertReversal(action: string, detail: string): void {
  logSystemEvent(action, detail);
  logger.warn({ action, detail }, '收到支付反向通知');
}
