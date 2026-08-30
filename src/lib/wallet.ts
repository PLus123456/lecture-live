import 'server-only';

import crypto from 'crypto';
import { Prisma, type UserRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { resolveRoleQuotas, resolveRoleStorageBytesLimit } from '@/lib/userRoles';
import { settlePoolOnLimitChange } from '@/lib/quota';
import { logSystemEvent } from '@/lib/auditLog';
import type { PaymentProviderMode, PaymentProviderName } from '@/lib/payment/types';
import {
  isPurchasableMembershipRole,
  type PurchasableMembershipRole,
} from '@/lib/payment/tierPolicy';
import { sendSubscriptionSuccessEmail } from '@/lib/email';
import {
  allocateWalletSpend,
  assertNoActivePaymentHold,
  createWalletFundingLot,
} from '@/lib/payment/fundingLedger';

/** 面向用户的钱包业务错误（余额不足 / 档位无效等）。路由据 code 回 4xx。 */
export class WalletError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'insufficient_balance'
      | 'tier_unavailable'
      | 'user_not_found'
      | 'admin_no_membership'
      | 'account_frozen'
      | 'bad_request' = 'bad_request'
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

/**
 * 购买订单的**发放快照**（下单时冻结，回调结算时按此发放，不再读 live 档位）。
 * 这样档位在下单→回调之间被删除 / 下架 / 改价都不影响到账发放：H1（发放不再因 live 档位消失而抛错
 * 回滚整笔到账）+ H2（按冻结价发放，杜绝 credit 用快照价、spend 用 live 价的漂移）。
 */
interface GrantSnapshot {
  kind: 'membership' | 'minutes';
  priceCents: number;
  tierId: string | null;
  tierName: string;
  grantRole?: UserRole | null;
  durationDays?: number | null;
  grantMinutes?: number | null;
}

interface OrderMetadata {
  creditCents?: number; // topup：到账余额（可 > 应付实现赠送）
  returnUrl?: string; // 支付完成后浏览器跳回
  subject?: string;
  grant?: GrantSnapshot; // purchase 订单：回调按此冻结快照发放
  // 仅用于识别迁移前历史快照；新代码绝不再以 metadata CAS 作为发放真源。
  grantedAt?: string;
}

function parseMeta(json: string | null): OrderMetadata {
  if (!json) return {};
  try {
    return JSON.parse(json) as OrderMetadata;
  } catch {
    return {};
  }
}

/** 生成我方订单号：LL + 时间基36 + 随机 hex（≤32 字符、纯 alnum，满足各网关 out_trade_no 约束）。 */
function generateOutTradeNo(): string {
  return `LL${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`.toUpperCase();
}

// 未支付订单有效期。这个值现在会**同时**下发给网关（Stripe expires_at /
// 支付宝 time_expire / 微信 time_expire），网关自己就会拒收超时支付 —— 否则我方
// 判定 late_paid 时钱已经被收走了，而 late_paid 不发放任何权益。
// 取 60 分钟而非 30：Stripe 要求 expires_at 至少为 30 分钟后，卡在下限上会因为
// 请求往返的几百毫秒被拒单。
export const ORDER_TTL_MS = 60 * 60_000;
const MAX_PROVIDER_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * 未支付订单**状态清扫**的宽限期：从 expiresAt 再往后推这么久才置 expired。
 *
 * 网关侧已经按 expiresAt 拒收超时支付，我方 creditPaidOrder 又在订单行锁内用
 * provider-signed paidAt 与 expiresAt 比对（晚付隔离成 late_paid、不发任何权益），
 * 所以这条清扫只是让列表状态好看，不是资金闸。留 72h 覆盖最长的一家重投窗口
 * （Stripe 约 3 天；支付宝/微信各约 24h），免得状态先于回调翻脸。
 * 兜底不变：认领 SQL 的 `status IN ('pending','expired','failed')` 收得住被扫早的行。
 */
export const PAYMENT_ORDER_EXPIRE_GRACE_MS = 72 * 60 * 60_000;

/** 归一化 ISO-4217 币种码（大写、去空白）；非法/空值回 ''，由调用方决定回落。 */
function normalizeCurrency(v: string | null | undefined): string {
  const s = (v ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : '';
}

export const DEFAULT_ORDER_CURRENCY = 'CNY';

/**
 * 通知必带实付金额的渠道（L20）。这三家的异步通知协议都含金额字段，缺失只可能是解析出错或
 * 伪造 —— 不能像 sandbox 那样「无金额就跳过对账」fail-open：那等于把 M1/M2 金额对账整条关掉。
 */
const AMOUNT_REQUIRED_PROVIDERS: PaymentProviderName[] = ['alipay', 'wechat', 'stripe'];

async function assertWalletAccountActive(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<void> {
  try {
    await assertNoActivePaymentHold(tx, userId);
  } catch (err) {
    if (err instanceof Error && err.message === 'payment_account_frozen') {
      throw new WalletError('账户存在未处理的支付争议，请联系管理员', 'account_frozen');
    }
    throw err;
  }
}

export interface WalletSummary {
  walletBalanceCents: number;
  purchasedMinutesBalance: number;
  role: UserRole;
  roleExpiresAt: Date | null;
}

export async function getWalletSummary(userId: string): Promise<WalletSummary | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      walletBalanceCents: true,
      purchasedMinutesBalance: true,
      role: true,
      roleExpiresAt: true,
    },
  });
  return user;
}

/**
 * 创建一笔支付订单（进账凭据）。kind='topup' 充值到余额（creditCents 可含赠送）；
 * kind='purchase' 直接买档位（到账后先入余额再等额出账并发放）。返回订单 + outTradeNo。
 */
export async function createPaymentOrder(input: {
  userId: string;
  provider: PaymentProviderName;
  providerMode?: PaymentProviderMode;
  providerAccount?: string;
  kind: 'topup' | 'purchase';
  amountCents: number;
  /** ISO-4217 币种码；下单时冻结到订单行，回调按 (amount, currency) 二元组对账（P3-15）。 */
  currency?: string;
  tierId?: string;
  creditCents?: number;
  returnUrl?: string;
  subject?: string;
  grant?: GrantSnapshot;
}) {
  const amountCents = Math.max(0, Math.round(input.amountCents));
  const metadata: OrderMetadata = {
    creditCents:
      input.kind === 'topup' ? input.creditCents ?? amountCents : amountCents,
    returnUrl: input.returnUrl,
    subject: input.subject,
    // purchase 订单冻结发放快照（H1/H2）；topup 无需。
    grant: input.kind === 'purchase' ? input.grant : undefined,
  };
  return prisma.$transaction(async (tx) => {
    // Serialize checkout with chargeback/debt creation. Reversal takes
    // PaymentOrder -> User -> hold; a brand-new order has no order row yet, so its first
    // shared boundary is the User row. Whichever transaction gets this lock first defines the
    // outcome: an already-frozen account cannot create another payable order, while an order
    // durably created first remains auditable if a different payment is disputed immediately after.
    const users = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM User WHERE id = ${input.userId} FOR UPDATE
    `;
    if (!users[0]) throw new WalletError('用户不存在', 'user_not_found');
    await assertWalletAccountActive(tx, input.userId);
    const order = await tx.paymentOrder.create({
      data: {
        userId: input.userId,
        provider: input.provider,
        kind: input.kind,
        tierId: input.tierId ?? null,
        outTradeNo: generateOutTradeNo(),
        amountCents,
        currency: normalizeCurrency(input.currency) || DEFAULT_ORDER_CURRENCY,
        status: 'pending',
        metadataJson: JSON.stringify(metadata),
        // Provider event timestamps are second-granular. Floor the deadline to the same
        // resolution so a payment at xx:00.900 cannot be reported as xx:00.000 and slip through
        // an expiresAt of xx:00.800. This is intentionally conservative by <1 second.
        expiresAt: new Date(
          Math.floor((Date.now() + ORDER_TTL_MS) / 1000) * 1000
        ),
      },
    });
    // New columns are written through SQL so this patch remains compilable before the shared
    // generated Prisma client is refreshed. Deployment's db push/migration installs them first.
    await tx.$executeRaw`
      UPDATE PaymentOrder
      SET providerMode = ${input.providerMode ?? (input.provider === 'sandbox' ? 'sandbox' : 'unknown')},
          providerAccount = ${(input.providerAccount || 'default').slice(0, 191)}
      WHERE id = ${order.id}
    `;
    return order;
  });
}

/**
 * 未支付订单清扫：把过了 expiresAt + 宽限期仍是 pending 的订单置为 expired。
 *
 * 在此之前 `PaymentOrder.expiresAt` 与 `@@index([status, expiresAt])` 是一对**死列** ——
 * 建单时写入、全仓无人读，`expired` 这个状态从来没在生产里存在过，pending 订单无限堆积。
 *
 * **落地顺序有硬依赖**：本函数必须晚于 creditPaidOrder 的认领 CAS 放宽（CLAIMABLE_ORDER_STATUSES
 * 收 expired）才允许启用，否则被扫过的订单遇到晚到的真实回调将永远无法入账。
 *
 * 只动 pending：failed/canceled/paid/refunded 都是已决终态，清扫器绝不覆写。
 */
export async function expireStalePaymentOrders(options?: {
  graceMs?: number;
  now?: Date;
}): Promise<number> {
  const now = options?.now ?? new Date();
  const graceMs = Math.max(0, options?.graceMs ?? PAYMENT_ORDER_EXPIRE_GRACE_MS);
  const cutoff = new Date(now.getTime() - graceMs);
  const result = await prisma.paymentOrder.updateMany({
    // expiresAt 为 NULL 的历史行不参与（SQL 三值逻辑下 NULL < cutoff 本就不成立，
    // 这里显式写出来是给读代码的人看的）。命中 @@index([status, expiresAt])。
    // fulfillmentStatus 必须仍是 pending：已进入 review/processing 的行由结算侧的状态机负责，
    // 状态清扫不该在人工复核队列里制造噪音。
    where: {
      status: 'pending',
      fulfillmentStatus: 'pending',
      expiresAt: { not: null, lt: cutoff },
    },
    data: { status: 'expired' },
  });
  if (result.count > 0) {
    logSystemEvent(
      'recharge.order.expired_sweep',
      `count=${result.count} cutoff=${cutoff.toISOString()} graceMs=${graceMs}`
    );
  }
  return result.count;
}

export interface CreditResult {
  ok: boolean;
  /** Durable terminal/review outcome that is safe to ACK even though no entitlement was granted. */
  acknowledged?: boolean;
  alreadyProcessed: boolean;
  status?: string;
  returnUrl?: string;
}

interface CreditClaimOutcome {
  order: LockedPaymentOrder | null;
  meta: OrderMetadata;
  claimedNow: boolean;
  reject: RejectReason;
  reviewStatus?: 'late_paid' | 'invalid_paid_at';
}

interface LockedPaymentOrder {
  id: string;
  userId: string;
  provider: string;
  kind: string;
  tierId: string | null;
  outTradeNo: string;
  providerRef: string | null;
  amountCents: number;
  currency: string;
  status: string;
  paidAt: Date | string | null;
  refundedAt: Date | string | null;
  fulfillmentStatus: string;
  reviewReason: string | null;
  metadataJson: string | null;
  createdAt: Date | string;
  expiresAt: Date | string | null;
}

/** tx1 的拒绝原因（同时是审计事件名后缀）。null = 通过。 */
type RejectReason =
  | 'refunded'
  | 'provider_mismatch'
  | 'amount_mismatch'
  | 'amount_missing'
  | 'currency_mismatch'
  | 'fulfillment_review'
  | null;

async function lockPaymentOrderForUpdate(
  tx: Prisma.TransactionClient,
  outTradeNo: string
): Promise<LockedPaymentOrder | null> {
  const rows = await tx.$queryRaw<LockedPaymentOrder[]>`
    SELECT id, userId, provider, kind, tierId, outTradeNo, providerRef,
           amountCents, currency, status, paidAt, refundedAt, fulfillmentStatus, reviewReason,
           metadataJson, createdAt, expiresAt
    FROM PaymentOrder
    WHERE outTradeNo = ${outTradeNo}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * SEC-027: payment claim, wallet credit, purchase debit and entitlement grant are one transaction.
 * Lock order is always PaymentOrder -> User. A refund takes the same locks in the same order, so
 * it can never observe `paid` while the wallet/entitlement half is still uncommitted.
 */
export async function creditPaidOrder(
  outTradeNo: string,
  providerRef?: string,
  expectedProvider?: PaymentProviderName,
  paidAmountCents?: number,
  paidCurrency?: string,
  paidOccurredAt?: Date
): Promise<CreditResult> {
  try {
    const claimed = await prisma.$transaction(async (tx): Promise<CreditClaimOutcome> => {
    const order = await lockPaymentOrderForUpdate(tx, outTradeNo);
    if (!order) {
      return {
        order: null as null,
        meta: {} as OrderMetadata,
        claimedNow: false,
        reject: null as RejectReason,
      };
    }
    const meta = parseMeta(order.metadataJson);

    // 已退款 / 已拒付的订单绝不再到账（P3-16 的反向通知写 refundedAt）：晚到的重复支付通知
    // 不能把一笔已经退回去的钱重新发一遍权益。
    if (order.refundedAt) {
      return { order, meta, claimedNow: false, reject: 'refunded' as RejectReason };
    }
    if (expectedProvider && order.provider && order.provider !== expectedProvider) {
      return { order, meta, claimedNow: false, reject: 'provider_mismatch' as RejectReason };
    }

    // 金额对账（M1/M2）：网关回报的实付金额须等于订单金额，否则拒绝到账（不认领，订单留 pending）。
    // 先读单不破坏幂等：认领仍以 status pending→paid 的原子 updateMany 为唯一锚点，并发重复回调
    // 只有一个 count=1。
    const amountReported =
      typeof paidAmountCents === 'number' && Number.isFinite(paidAmountCents);
    if (amountReported && Math.round(paidAmountCents as number) !== order.amountCents) {
      return { order, meta, claimedNow: false, reject: 'amount_mismatch' as RejectReason };
    }
    // L20：真实网关缺金额字段 = 解析出错或伪造，不能当成「无金额渠道」跳过对账。sandbox 天生
    // 无金额，仍走跳过。
    if (
      !amountReported &&
      expectedProvider &&
      AMOUNT_REQUIRED_PROVIDERS.includes(expectedProvider)
    ) {
      return { order, meta, claimedNow: false, reject: 'amount_missing' as RejectReason };
    }
    // 币种对账（P3-15）：只比金额挡不住跨币种套利——3900「美分」与 3900「分」在 amountCents 上
    // 完全相等却相差约 7.1 倍。订单币种下单时冻结，回调回报的币种须与之一致（渠道给不出则跳过）。
    const reportedCurrency = normalizeCurrency(paidCurrency);
    if (
      reportedCurrency &&
      reportedCurrency !== (normalizeCurrency(order.currency) || DEFAULT_ORDER_CURRENCY)
    ) {
      return { order, meta, claimedNow: false, reject: 'currency_mismatch' as RejectReason };
    }

    if (order.status === 'paid' && order.fulfillmentStatus === 'fulfilled') {
      return { order, meta, claimedNow: false, reject: null as RejectReason };
    }
    if (order.status === 'late_paid') {
      return {
        order,
        meta,
        claimedNow: false,
        reject: null as RejectReason,
        reviewStatus: 'late_paid',
      };
    }
    if (
      order.fulfillmentStatus === 'review' &&
      order.reviewReason === 'payment_before_order'
    ) {
      return {
        order,
        meta,
        claimedNow: false,
        reject: null,
        reviewStatus: 'invalid_paid_at',
      };
    }
    const retryableUncommittedFailure =
      order.fulfillmentStatus === 'review' &&
      order.reviewReason === 'fulfillment_failed_uncommitted' &&
      ['pending', 'expired', 'failed'].includes(order.status);
    if (order.fulfillmentStatus === 'review' && !retryableUncommittedFailure) {
      return { order, meta, claimedNow: false, reject: 'fulfillment_review' as RejectReason };
    }

    const paidAt =
      paidOccurredAt instanceof Date && Number.isFinite(paidOccurredAt.getTime())
        ? paidOccurredAt
        : new Date();
    const expiresAt = order.expiresAt ? new Date(order.expiresAt) : null;
    const createdAt = new Date(order.createdAt);
    if (
      Number.isFinite(createdAt.getTime()) &&
      paidAt.getTime() < createdAt.getTime() - MAX_PROVIDER_CLOCK_SKEW_MS
    ) {
      await tx.$executeRaw`
        UPDATE PaymentOrder
        SET paidAt = ${paidAt}, fulfillmentStatus = 'review',
            reviewReason = 'payment_before_order',
            fulfillmentError = 'provider payment timestamp predates order creation'
        WHERE id = ${order.id} AND status NOT IN ('paid', 'refunded')
      `;
      return {
        order: {
          ...order,
          paidAt,
          fulfillmentStatus: 'review',
          reviewReason: 'payment_before_order',
        },
        meta,
        claimedNow: true,
        reject: null,
        reviewStatus: 'invalid_paid_at',
      };
    }
    if (expiresAt && Number.isFinite(expiresAt.getTime()) && paidAt >= expiresAt) {
      await tx.$executeRaw`
        UPDATE PaymentOrder
        SET status = 'late_paid', paidAt = ${paidAt},
            providerRef = COALESCE(${providerRef ?? null}, providerRef),
            fulfillmentStatus = 'review', reviewReason = 'payment_after_expiry',
            fulfillmentError = 'provider-confirmed payment occurred after expiresAt'
        WHERE id = ${order.id} AND status NOT IN ('paid', 'refunded')
      `;
      return {
        order: { ...order, status: 'late_paid', fulfillmentStatus: 'review', paidAt },
        meta,
        claimedNow: true,
        reject: null,
        reviewStatus: 'late_paid',
      };
    }
    // A delayed webhook may arrive after cron marked the order expired (or checkout timed out and
    // marked it failed). A signed provider paidAt before expiresAt is authoritative and can resume.
    if (!['pending', 'expired', 'failed'].includes(order.status)) {
      return { order, meta, claimedNow: false, reject: null as RejectReason };
    }
    await tx.$executeRaw`
      UPDATE PaymentOrder
      SET status = 'paid', paidAt = ${paidAt},
          providerRef = COALESCE(${providerRef ?? null}, providerRef),
          fulfillmentStatus = 'processing', fulfillmentStartedAt = NOW(3),
          fulfillmentError = NULL, reviewReason = NULL
      WHERE id = ${order.id} AND status IN ('pending', 'expired', 'failed')
    `;

    // Explicit user lock closes both topup and purchase paths and fixes one global lock order.
    const userLock = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM User WHERE id = ${order.userId} FOR UPDATE
    `;
    if (!userLock[0]) throw new WalletError('用户不存在', 'user_not_found');
    await assertWalletAccountActive(tx, order.userId);

    // Credit first, then (for direct purchase) spend the exact frozen price and grant in the same
    // transaction. Any error rolls all of it back, including the paid/processing transition.
    const creditCents = Math.max(0, Math.round(meta.creditCents ?? order.amountCents));
    const credited = await tx.user.update({
      where: { id: order.userId },
      data: { walletBalanceCents: { increment: creditCents } },
      select: { walletBalanceCents: true },
    });
    const topupTx = await tx.walletTransaction.create({
      data: {
        userId: order.userId,
        type: 'topup',
        amountCents: creditCents,
        balanceAfterCents: credited.walletBalanceCents,
        orderId: order.id,
      },
    });
    const fundingLotId = await createWalletFundingLot(tx, {
      userId: order.userId,
      sourceOrderId: order.id,
      sourceTransactionId: topupTx.id,
      sourceKind: 'payment',
      amountCents: creditCents,
    });

    if (order.kind === 'purchase') {
      const spec = meta.grant ?? (await resolveTierGrant(tx, order.tierId));
      if (!spec) {
        throw new WalletError('档位快照缺失且档位已不存在', 'tier_unavailable');
      }
      await applyGrantTx(tx, order.userId, spec, {
        orderId: order.id,
        sourceFundingLotId: fundingLotId,
      });
    }

    await tx.$executeRaw`
      UPDATE PaymentOrder
      SET fulfillmentStatus = 'fulfilled', fulfilledAt = NOW(3),
          fulfillmentError = NULL, reviewReason = NULL
      WHERE id = ${order.id} AND status = 'paid' AND fulfillmentStatus = 'processing'
    `;

    return { order, meta, claimedNow: true, reject: null as RejectReason };
  });

    const { order, meta } = claimed;
    if (!order) {
      return { ok: false, alreadyProcessed: false };
    }
    if (claimed.reviewStatus) {
      const durableStatus =
        claimed.reviewStatus === 'late_paid' ? 'late_paid' : 'review';
      logSystemEvent(
        `recharge.callback.${claimed.reviewStatus}`,
        `outTradeNo=${outTradeNo} paidAt=${String(order.paidAt ?? paidOccurredAt ?? '')} expiresAt=${String(order.expiresAt ?? '')}`
      );
      return {
        ok: false,
        acknowledged: true,
        alreadyProcessed: !claimed.claimedNow,
        status: durableStatus,
        returnUrl: meta.returnUrl,
      };
    }
    if (claimed.reject) {
      logSystemEvent(
        `recharge.callback.${claimed.reject}`,
        `outTradeNo=${outTradeNo} expected=${order.amountCents}${
          normalizeCurrency(order.currency) || DEFAULT_ORDER_CURRENCY
        } paid=${paidAmountCents}${normalizeCurrency(paidCurrency)} provider=${expectedProvider ?? '-'}`
      );
      return {
        ok: false,
        // A signed paid event delivered after an already-durable reversal is terminal and safe
        // to ACK: refundedAt is the entitlement gate, so retries can never grant rights.
        ...(claimed.reject === 'refunded' ? { acknowledged: true } : {}),
        alreadyProcessed: false,
        status: order.status,
        returnUrl: meta.returnUrl,
      };
    }
    if (!claimed.claimedNow) {
      return {
        ok: order.status === 'paid' && order.fulfillmentStatus === 'fulfilled',
        alreadyProcessed: true,
        status: order.status,
        returnUrl: meta.returnUrl,
      };
    }

    void notifyOrderCredited(order.id).catch(() => undefined);
    return { ok: true, alreadyProcessed: false, status: 'paid', returnUrl: meta.returnUrl };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    logSystemEvent('recharge.fulfillment.failed', `outTradeNo=${outTradeNo} reason=${reason}`);
    if (err instanceof WalletError) {
      const changed = await prisma.$executeRaw`
        UPDATE PaymentOrder
        SET fulfillmentStatus = 'review',
            reviewReason = 'fulfillment_failed_uncommitted',
            fulfillmentError = ${reason.slice(0, 4096)}
        WHERE outTradeNo = ${outTradeNo}
          AND refundedAt IS NULL
          AND status <> 'refunded'
          AND fulfillmentStatus NOT IN ('fulfilled', 'reversed')
      `;
      if (Number(changed) === 0) {
        const terminal = await prisma.$queryRaw<
          Array<{ status: string; refundedAt: Date | string | null; fulfillmentStatus: string }>
        >`
          SELECT status, refundedAt, fulfillmentStatus
          FROM PaymentOrder WHERE outTradeNo = ${outTradeNo} LIMIT 1
        `;
        if (
          terminal[0] &&
          (terminal[0].status === 'refunded' ||
            terminal[0].refundedAt ||
            terminal[0].fulfillmentStatus === 'reversed')
        ) {
          return {
            ok: false,
            acknowledged: true,
            alreadyProcessed: true,
            status: 'refunded',
          };
        }
      }
      return { ok: false, alreadyProcessed: false, status: 'review' };
    }
    throw err;
  }
}

const yuan = (cents: number) => `¥${(Math.max(0, cents) / 100).toFixed(2)}`;

/**
 * 订单到账后给用户发一封「订阅/购买成功」通知邮件。fire-and-forget、事务外调用。
 * 重新读订单 + 用户当前状态（拿到发放后的最新 role/到期），失败只吞不影响支付主流程。
 */
async function notifyOrderCredited(orderId: string): Promise<void> {
  const order = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
  if (!order) return;
  const user = await prisma.user.findUnique({
    where: { id: order.userId },
    select: { id: true, email: true, displayName: true, emailPreferences: true, roleExpiresAt: true },
  });
  if (!user) return;

  const meta = parseMeta(order.metadataJson);
  const planName =
    order.kind === 'purchase'
      ? meta.grant?.tierName ?? '会员/时长'
      : '钱包充值';
  // 会员购买必然写入真实到期日（applyGrantTx 的 days 至少为 1），所以这里 roleExpiresAt 为空
  // 只可能是异常态（发放失败/被并发改写），绝不是「永久有效」—— 真正的永久角色只有 admin 手工授予。
  // 拿不准就不写这一行（模板对空值直接省略），也好过向用户断言一个它并没有得到的权益。
  const expiresLabel =
    order.kind === 'purchase' && meta.grant?.kind === 'membership' && user.roleExpiresAt
      ? user.roleExpiresAt.toLocaleDateString('zh-CN')
      : null;

  // 报**实际入账额**而非订单应付额（P3-13）：topup 档的 creditCents 与应付额可以不等（赠送），
  // 也可能被误配成 0 —— 那时报应付额就等于发一封「已充值 ¥100」的假信，而钱包其实一分没进。
  const creditedCents = Math.max(0, Math.round(meta.creditCents ?? order.amountCents));

  await sendSubscriptionSuccessEmail(user, {
    planName,
    amountLabel: yuan(creditedCents),
    expiresLabel,
  });
}

/**
 * 用钱包余额购买档位（无支付渠道，纯余额出账）。事务内原子：校验余额 → 扣款 → 记台账 → 发放。
 * 供「先充值后消费」的用户端与 admin 代购调用。
 */
export async function spendFromBalance(
  userId: string,
  tierId: string,
  opts: { operatorId?: string } = {}
): Promise<void> {
  const spec = await prisma.$transaction(async (tx) => {
    return spendOnTierTx(tx, userId, tierId, opts);
  });

  // 余额购买此前完全不发通知：钱扣了、角色变了、tokenVersion++ 还把人踢下线，用户零感知。
  // 网关支付走 creditPaidOrder 有确认信，纯余额出账没有 —— 同一笔消费两条路径待遇不同。
  // 必须排在事务**提交之后**：放事务里既拖长事务，回滚后还会留下一封说谎的确认信。
  void notifyBalancePurchase(userId, spec).catch(() => undefined);
}

/**
 * 余额购买成功后的确认邮件。fire-and-forget、事务外调用。
 * 与 notifyOrderCredited 同源同模板，区别只是没有 PaymentOrder（纯余额出账不建订单行）。
 */
async function notifyBalancePurchase(
  userId: string,
  spec: GrantSnapshot
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true, emailPreferences: true, roleExpiresAt: true },
  });
  if (!user) return;

  // 同 notifyOrderCredited 的口径：只有确实拿到到期日的会员购买才写有效期。
  // 空值一律省略该行，绝不渲染成「永久有效」—— 那正是审计 #3 里最糟的谎报。
  const expiresLabel =
    spec.kind === 'membership' && user.roleExpiresAt
      ? user.roleExpiresAt.toLocaleDateString('zh-CN')
      : null;

  await sendSubscriptionSuccessEmail(user, {
    planName: spec.tierName,
    amountLabel: yuan(spec.priceCents),
    expiresLabel,
  });
}

/** 从 live 档位解析发放规格（校验存在、未下架、非 topup）；供余额购买（读实时档位）用。 */
async function resolveTierGrant(
  tx: Prisma.TransactionClient,
  tierId: string | null
): Promise<GrantSnapshot | null> {
  if (!tierId) return null;
  const tier = await tx.rechargeTier.findUnique({ where: { id: tierId } });
  if (!tier || !tier.active) {
    throw new WalletError('档位不存在或已下架', 'tier_unavailable');
  }
  if (tier.kind !== 'membership' && tier.kind !== 'minutes') {
    // topup 档位不应走「购买发放」路径。
    throw new WalletError('该档位不可用余额购买', 'tier_unavailable');
  }
  if (
    tier.kind === 'membership' &&
    !isPurchasableMembershipRole(tier.grantRole ?? 'PRO')
  ) {
    throw new WalletError('会员商品不能授予管理员角色', 'tier_unavailable');
  }
  return {
    kind: tier.kind === 'membership' ? 'membership' : 'minutes',
    priceCents: tier.priceCents,
    tierId: tier.id,
    tierName: tier.name,
    grantRole: tier.grantRole,
    durationDays: tier.durationDays,
    grantMinutes: tier.grantMinutes,
  };
}

async function recordPaymentEntitlement(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    sourceOrderId?: string;
    walletTransactionId: string | undefined;
    kind: 'membership' | 'minutes';
    grantRole?: UserRole | null;
    totalUnits: number;
    priceCents: number;
  }
): Promise<string> {
  if (!input.walletTransactionId) {
    throw new Error('wallet transaction id missing for entitlement ledger');
  }
  const entitlementId = crypto.randomUUID();
  await tx.$executeRaw`
    INSERT INTO PaymentEntitlement (
      id, userId, sourceOrderId, walletTransactionId, kind, grantRole,
      totalUnits, revokedUnits, priceCents, status, grantedAt, createdAt, updatedAt
    ) VALUES (
      ${entitlementId}, ${input.userId}, ${input.sourceOrderId ?? null},
      ${input.walletTransactionId}, ${input.kind}, ${input.grantRole ?? null},
      ${Math.max(0, Math.round(input.totalUnits))}, 0,
      ${Math.max(0, Math.round(input.priceCents))}, 'active', NOW(3), NOW(3), NOW(3)
    )
  `;
  return entitlementId;
}

/**
 * 事务内：按发放规格从余额扣款并发放（会员=改 role/到期；时间=加永久池）。
 * 规格可来自 live 档位（余额购买）或订单冻结快照（回调结算，H1/H2）。
 */
async function applyGrantTx(
  tx: Prisma.TransactionClient,
  userId: string,
  spec: GrantSnapshot,
  opts: { operatorId?: string; orderId?: string; sourceFundingLotId?: string }
): Promise<void> {
  const priceCents = Math.max(0, Math.round(spec.priceCents));
  // P3-7：0 元的会员/时长档 = 提款机。下面的扣款守卫是 `walletBalanceCents >= 0`，对 0 元恒真
  // 恒 count=1，任何人可无限次领永久分钟。档位管理口已挡（tiers 路由要求 >0），这里再挡一道：
  // 冻结快照可能来自建管口收紧之前的 0 元档。
  if (priceCents <= 0) {
    throw new WalletError('档位价格无效（必须大于 0）', 'tier_unavailable');
  }
  // M7 / 最终发放闸：**绝不**通过购买发放 ADMIN。订单 metadata 是下单时冻结的历史快照，
  // 可能来自收紧之前的 ADMIN 档位，而回调结算按快照发放、根本不读 live 档位——所以档位管理口
  // （tiers 路由）拒绝写入之外，这里必须再挡一道。用 isPurchasableMembershipRole 而不是
  // `=== 'ADMIN'`：它同时拒掉任何非 PRO/FREE 的脏值。必须在任何扣款、锁读、配额修改前拒绝。
  let purchasableRole: PurchasableMembershipRole | null = null;
  if (spec.kind === 'membership') {
    const requestedRole = spec.grantRole ?? 'PRO';
    if (!isPurchasableMembershipRole(requestedRole)) {
      throw new WalletError('会员商品不能授予管理员角色', 'tier_unavailable');
    }
    purchasableRole = requestedRole;
  }
  // 锁读（P3-6）：会员发放对 roleExpiresAt / originalRole 是读-改-写，快照读在并发网关回调下
  // 必然 lost update —— 两笔各扣一次钱、到期只延一期，且台账看起来完全正常。FOR UPDATE 让第二笔
  // 排在第一笔提交之后再读（同 quota.ts / chatFileCleanup.ts 的锁读 idiom）。
  // 顺带把 transcriptionMinutesLimit 一起读出来，供 P1-4 的池结算判断旧上限。
  const rows = await tx.$queryRaw<
    Array<{
      walletBalanceCents: number;
      role: UserRole;
      originalRole: UserRole | null;
      roleExpiresAt: Date | string | null;
      transcriptionMinutesLimit: number;
    }>
  >`
    SELECT walletBalanceCents, role, originalRole, roleExpiresAt, transcriptionMinutesLimit
    FROM User WHERE id = ${userId} FOR UPDATE
  `;
  const row = rows?.[0];
  if (!row) throw new WalletError('用户不存在', 'user_not_found');
  const user = {
    walletBalanceCents: Number(row.walletBalanceCents),
    role: row.role,
    originalRole: row.originalRole,
    roleExpiresAt: row.roleExpiresAt ? new Date(row.roleExpiresAt) : null,
    transcriptionMinutesLimit: Number(row.transcriptionMinutesLimit),
  };
  await assertWalletAccountActive(tx, userId);
  if (spec.kind === 'membership' && user.role === 'ADMIN') {
    throw new WalletError('管理员无需购买会员', 'admin_no_membership');
  }

  // 原子扣款守卫（C1 防并发双花）：仅当 walletBalanceCents>=price 时才扣，count=0 视为余额不足。
  // WHERE gte 让扣款走锁定当前读、在行锁上串行化，杜绝超扣（与 quota.ts / streamGrant.ts 的 FOR UPDATE 一致）。
  const spent = await tx.user.updateMany({
    where: { id: userId, walletBalanceCents: { gte: priceCents } },
    data: { walletBalanceCents: { decrement: priceCents } },
  });
  if (spent.count === 0) {
    throw new WalletError('钱包余额不足', 'insufficient_balance');
  }
  const after = await tx.user.findUnique({
    where: { id: userId },
    select: { walletBalanceCents: true },
  });
  const balanceAfter = after?.walletBalanceCents ?? user.walletBalanceCents - priceCents;

  if (spec.kind === 'membership') {
    const grantRole: UserRole = purchasableRole ?? 'PRO';
    const days = Math.max(1, spec.durationDays ?? 30);
    const now = new Date();
    // 叠加续期：从「现有未过期到期日」或「现在」起算，取较晚者。
    const base =
      user.roleExpiresAt && user.roleExpiresAt > now ? user.roleExpiresAt : now;
    const newExpiry = new Date(base.getTime() + days * 86_400_000);
    // 到期回退目标（M3：不抹掉永久提权角色）：
    //  - 已在付费期（originalRole 已记）→ 保留原回退目标；
    //  - 否则当前角色即回退目标。仅当当前角色是**临时**会员（有 roleExpiresAt）却又恰等于 grantRole
    //    时才回退 FREE；**永久**提权角色（roleExpiresAt===null，如 admin 授予的永久 PRO）必须保留为回退
    //    目标，否则到期 cron 会把它误降为 FREE、静默抹掉用户本就拥有的永久权益。
    let originalRole: UserRole;
    if (user.originalRole != null) {
      originalRole = user.originalRole;
    } else if (user.roleExpiresAt == null) {
      originalRole = user.role; // 当前角色是永久的（天然 FREE 或永久提权）→ 直接作回退目标
    } else {
      originalRole = user.role === grantRole ? 'FREE' : user.role;
    }
    const quotas = await resolveRoleQuotas(grantRole);
    const storageBytesLimit = await resolveRoleStorageBytesLimit(grantRole);
    // P1-4：买会员会把月度上限改写成角色默认值，这相对**自定义组高限额**或 admin 单用户配额覆盖
    // 可能是**下调**。不结算就改列，随后的月度重置会拿「旧周期已用 − 新上限」当欠账去扣永久池，
    // 把用户刚花钱买到的分钟蒸发掉（真库实测 limit 5000/池 500/used 4000 → 买 PRO 后池归 0）。
    // 必须与本次发放同事务：中途失败不能留下「上限已降、池未结算」的中间态。
    const oldLimit = user.transcriptionMinutesLimit;
    const newLimit = quotas.transcriptionMinutesLimit;
    if (Number.isFinite(oldLimit) && Number.isFinite(newLimit) && newLimit < oldLimit) {
      await settlePoolOnLimitChange(userId, oldLimit, newLimit, tx);
    }
    await tx.user.update({
      where: { id: userId },
      data: {
        role: grantRole,
        originalRole,
        roleExpiresAt: newExpiry,
        // 购买系统角色会员即脱离自定义组，按角色默认配额（上调不触发 Model A 池结算，下调见上）。
        customGroupId: null,
        transcriptionMinutesLimit: quotas.transcriptionMinutesLimit,
        storageHoursLimit: quotas.storageHoursLimit,
        allowedModels: quotas.allowedModels,
        storageBytesLimit,
        // 自增 tokenVersion 让旧 JWT 失效，下次请求按新角色重签发。
        tokenVersion: { increment: 1 },
      },
    });
    const purchaseTx = await tx.walletTransaction.create({
      data: {
        userId,
        type: 'purchase_membership',
        amountCents: -priceCents,
        balanceAfterCents: balanceAfter,
        orderId: opts.orderId ?? null,
        tierId: spec.tierId,
        operatorId: opts.operatorId ?? null,
        note: `${spec.tierName}（${grantRole} ${days}天）`,
      },
    });
    const entitlementId = await recordPaymentEntitlement(tx, {
      userId,
      sourceOrderId: opts.orderId,
      walletTransactionId: purchaseTx.id,
      kind: 'membership',
      grantRole,
      totalUnits: days,
      priceCents,
    });
    await allocateWalletSpend(tx, {
      userId,
      spendTransactionId: purchaseTx.id,
      amountCents: priceCents,
      balanceAfterCents: balanceAfter,
      targetKind: 'membership',
      entitlementId,
      totalUnits: days,
      forcedFundingLotId: opts.sourceFundingLotId,
    });
  } else {
    const minutes = Math.max(0, spec.grantMinutes ?? 0);
    await tx.user.update({
      where: { id: userId },
      data: { purchasedMinutesBalance: { increment: minutes } },
    });
    const purchaseTx = await tx.walletTransaction.create({
      data: {
        userId,
        type: 'purchase_minutes',
        amountCents: -priceCents,
        balanceAfterCents: balanceAfter,
        minutesDelta: minutes,
        orderId: opts.orderId ?? null,
        tierId: spec.tierId,
        operatorId: opts.operatorId ?? null,
        note: `${spec.tierName}（+${minutes}分钟）`,
      },
    });
    const entitlementId = await recordPaymentEntitlement(tx, {
      userId,
      sourceOrderId: opts.orderId,
      walletTransactionId: purchaseTx.id,
      kind: 'minutes',
      totalUnits: minutes,
      priceCents,
    });
    await allocateWalletSpend(tx, {
      userId,
      spendTransactionId: purchaseTx.id,
      amountCents: priceCents,
      balanceAfterCents: balanceAfter,
      targetKind: 'minutes',
      entitlementId,
      totalUnits: minutes,
      forcedFundingLotId: opts.sourceFundingLotId,
    });
  }
}

/** 事务内：用余额购买 live 档位（校验未下架）。供余额购买与 admin 代购。 */
async function spendOnTierTx(
  tx: Prisma.TransactionClient,
  userId: string,
  tierId: string,
  opts: { operatorId?: string; orderId?: string; sourceFundingLotId?: string }
): Promise<GrantSnapshot> {
  const spec = await resolveTierGrant(tx, tierId);
  if (!spec) throw new WalletError('档位不存在或已下架', 'tier_unavailable');
  await applyGrantTx(tx, userId, spec, opts);
  // 回传给调用方在事务提交后发确认邮件（事务内拿不到「已提交」这个事实）。
  return spec;
}

/**
 * 管理员手动调整：余额（amountCentsDelta，有符号）和/或永久时长池（minutesDelta，有符号）。
 * 记 admin_adjust 台账（operatorId=操作管理员）。余额与时长池都不可调至负数（截 0）。
 * 返回**实际生效**的增量，供路由记审计日志（P3-18：日志不能记请求值，否则与台账互相矛盾）。
 */
export async function adminAdjust(input: {
  userId: string;
  amountCentsDelta?: number;
  minutesDelta?: number;
  note?: string;
  operatorId: string;
}): Promise<{ amountCentsDelta: number; minutesDelta: number }> {
  const amountDelta = Math.round(input.amountCentsDelta ?? 0);
  const minutesDelta = Math.round(input.minutesDelta ?? 0);
  if (amountDelta === 0 && minutesDelta === 0) {
    throw new WalletError('无调整内容', 'bad_request');
  }
  return prisma.$transaction(async (tx) => {
    // 锁读：截断量按「我们真正写进去的那个值」算。快照读 + GREATEST 写会在并发调整下算出与实际
    // 不符的 effective 值，台账随即失真。
    const rows = await tx.$queryRaw<
      Array<{ walletBalanceCents: number; purchasedMinutesBalance: number }>
    >`
      SELECT walletBalanceCents, purchasedMinutesBalance
      FROM User WHERE id = ${input.userId} FOR UPDATE
    `;
    const locked = rows?.[0];
    if (!locked) throw new WalletError('用户不存在', 'user_not_found');
    const user = {
      walletBalanceCents: Number(locked.walletBalanceCents),
      purchasedMinutesBalance: Number(locked.purchasedMinutesBalance),
    };

    // 余额不减到负数：实际增量按当前余额截断。
    const effectiveAmountDelta =
      amountDelta < 0
        ? -Math.min(user.walletBalanceCents, -amountDelta)
        : amountDelta;
    // 时长同理按当前池截断——台账须记**实际生效**值而非请求值（M4：否则负向调整超出池余额时
    // 台账虚报扣减量，与实际 GREATEST 截断后的池不符，污染审计/展示）。
    const effectiveMinutesDelta =
      minutesDelta < 0
        ? -Math.min(user.purchasedMinutesBalance, -minutesDelta)
        : minutesDelta;

    const data: Prisma.UserUpdateInput = {};
    // 正向两条都能用 increment；负向必须走 raw + GREATEST（见下）。
    if (amountDelta > 0) {
      data.walletBalanceCents = { increment: amountDelta };
    }
    if (minutesDelta > 0) {
      data.purchasedMinutesBalance = { increment: minutesDelta };
    }
    let balanceAfter = user.walletBalanceCents + effectiveAmountDelta;
    if (Object.keys(data).length > 0) {
      const updated = await tx.user.update({
        where: { id: input.userId },
        data,
        select: { walletBalanceCents: true },
      });
      balanceAfter = updated.walletBalanceCents;
    }
    // P3-17：负向余额调整此前是无护栏的 `increment: 负数`，与时长池那条防护不对称——快照与实际
    // 余额之间只要有一次并发消费，余额就会被打成负数（负余额一旦落库，所有 `gte` 扣款守卫全部
    // 失效，且门禁按「有钱」放行）。与时长池同款：raw + GREATEST 兜底。
    if (amountDelta < 0) {
      await tx.$executeRaw`
        UPDATE User
        SET walletBalanceCents = GREATEST(0, walletBalanceCents - ${-amountDelta})
        WHERE id = ${input.userId}
      `;
      balanceAfter = Math.max(0, user.walletBalanceCents + amountDelta);
    }
    // 负向时长调整用 raw + GREATEST 防负。
    if (minutesDelta < 0) {
      await tx.$executeRaw`
        UPDATE User
        SET purchasedMinutesBalance = GREATEST(0, purchasedMinutesBalance - ${-minutesDelta})
        WHERE id = ${input.userId}
      `;
    }

    const adminTx = await tx.walletTransaction.create({
      data: {
        userId: input.userId,
        type: 'admin_adjust',
        amountCents: effectiveAmountDelta,
        balanceAfterCents: balanceAfter,
        minutesDelta: effectiveMinutesDelta !== 0 ? effectiveMinutesDelta : null,
        operatorId: input.operatorId,
        note: input.note ?? null,
      },
    });
    if (effectiveAmountDelta > 0) {
      await createWalletFundingLot(tx, {
        userId: input.userId,
        sourceTransactionId: adminTx.id,
        sourceKind: 'admin',
        amountCents: effectiveAmountDelta,
      });
    } else if (effectiveAmountDelta < 0) {
      await allocateWalletSpend(tx, {
        userId: input.userId,
        spendTransactionId: adminTx.id,
        amountCents: -effectiveAmountDelta,
        balanceAfterCents: balanceAfter,
        targetKind: 'admin',
      });
    }
    return { amountCentsDelta: effectiveAmountDelta, minutesDelta: effectiveMinutesDelta };
  });
}

/**
 * 通用服务消费出账（当前消费方：文档翻译 type='translation'）。
 * 原子守卫同 applyGrantTx（C1）：WHERE walletBalanceCents>=amount 条件扣减，count=0 抛
 * insufficient_balance；行锁串行化并发，杜绝双花/负余额。记 WalletTransaction 台账。
 * **幂等由调用方保证**（翻译确认端点先做任务状态 CAS，赢家才进这里扣款）。
 * 可传入外部事务 tx（与业务状态写入同事务提交，避免「扣了钱任务没建起来」）。
 */
export async function spendWalletCents(
  input: {
    userId: string;
    amountCents: number;
    type: string;
    note?: string;
    operatorId?: string;
  },
  tx?: Prisma.TransactionClient
): Promise<{ balanceAfterCents: number }> {
  const amount = Math.round(input.amountCents);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new WalletError('扣费金额非法', 'bad_request');
  }
  const run = async (db: Prisma.TransactionClient) => {
    const locked = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM User WHERE id = ${input.userId} FOR UPDATE
    `;
    if (!locked[0]) throw new WalletError('用户不存在', 'user_not_found');
    await assertWalletAccountActive(db, input.userId);
    const spent = await db.user.updateMany({
      where: { id: input.userId, walletBalanceCents: { gte: amount } },
      data: { walletBalanceCents: { decrement: amount } },
    });
    if (spent.count === 0) {
      throw new WalletError('钱包余额不足', 'insufficient_balance');
    }
    const after = await db.user.findUnique({
      where: { id: input.userId },
      select: { walletBalanceCents: true },
    });
    const balanceAfterCents = after?.walletBalanceCents ?? 0;
    const spendTx = await db.walletTransaction.create({
      data: {
        userId: input.userId,
        type: input.type,
        amountCents: -amount,
        balanceAfterCents,
        operatorId: input.operatorId ?? null,
        note: input.note ?? null,
      },
    });
    await allocateWalletSpend(db, {
      userId: input.userId,
      spendTransactionId: spendTx.id,
      amountCents: amount,
      balanceAfterCents,
      targetKind: 'service',
    });
    return { balanceAfterCents };
  };
  return tx ? run(tx) : prisma.$transaction(run);
}

/**
 * 通用服务退款入账（当前消费方：文档翻译 type='translation_refund'）。
 * 加钱无守卫；**幂等由调用方保证**（翻译退款用 TranslationTask.refundedAt 的 CAS 闸，
 * 赢家才进这里入账）。可传入外部事务与业务状态同事务提交。
 */
export async function refundWalletCents(
  input: {
    userId: string;
    amountCents: number;
    type: string;
    note?: string;
    operatorId?: string;
  },
  tx?: Prisma.TransactionClient
): Promise<{ balanceAfterCents: number }> {
  const amount = Math.round(input.amountCents);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new WalletError('退款金额非法', 'bad_request');
  }
  const run = async (db: Prisma.TransactionClient) => {
    const locked = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM User WHERE id = ${input.userId} FOR UPDATE
    `;
    if (!locked[0]) throw new WalletError('用户不存在', 'user_not_found');
    const updated = await db.user
      .update({
        where: { id: input.userId },
        data: { walletBalanceCents: { increment: amount } },
        select: { walletBalanceCents: true },
      })
      .catch(() => null);
    if (!updated) throw new WalletError('用户不存在', 'user_not_found');
    const refundTx = await db.walletTransaction.create({
      data: {
        userId: input.userId,
        type: input.type,
        amountCents: amount,
        balanceAfterCents: updated.walletBalanceCents,
        operatorId: input.operatorId ?? null,
        note: input.note ?? null,
      },
    });
    await createWalletFundingLot(db, {
      userId: input.userId,
      sourceTransactionId: refundTx.id,
      sourceKind: 'service_refund',
      amountCents: amount,
    });
    return { balanceAfterCents: updated.walletBalanceCents };
  };
  return tx ? run(tx) : prisma.$transaction(run);
}
