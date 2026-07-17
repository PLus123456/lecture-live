import 'server-only';

import crypto from 'crypto';
import { Prisma, type UserRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { resolveRoleQuotas, resolveRoleStorageBytesLimit } from '@/lib/userRoles';
import type { PaymentProviderName } from '@/lib/payment/types';

/** 面向用户的钱包业务错误（余额不足 / 档位无效等）。路由据 code 回 4xx。 */
export class WalletError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'insufficient_balance'
      | 'tier_unavailable'
      | 'user_not_found'
      | 'admin_no_membership'
      | 'bad_request' = 'bad_request'
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

interface OrderMetadata {
  creditCents?: number; // topup：到账余额（可 > 应付实现赠送）
  returnUrl?: string; // 支付完成后浏览器跳回
  subject?: string;
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

const ORDER_TTL_MS = 30 * 60_000; // 未支付订单 30 分钟过期

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
  kind: 'topup' | 'purchase';
  amountCents: number;
  tierId?: string;
  creditCents?: number;
  returnUrl?: string;
  subject?: string;
}) {
  const amountCents = Math.max(0, Math.round(input.amountCents));
  const metadata: OrderMetadata = {
    creditCents:
      input.kind === 'topup' ? input.creditCents ?? amountCents : amountCents,
    returnUrl: input.returnUrl,
    subject: input.subject,
  };
  return prisma.paymentOrder.create({
    data: {
      userId: input.userId,
      provider: input.provider,
      kind: input.kind,
      tierId: input.tierId ?? null,
      outTradeNo: generateOutTradeNo(),
      amountCents,
      status: 'pending',
      metadataJson: JSON.stringify(metadata),
      expiresAt: new Date(Date.now() + ORDER_TTL_MS),
    },
  });
}

export interface CreditResult {
  ok: boolean;
  alreadyProcessed: boolean;
  status?: string;
  returnUrl?: string;
}

/**
 * 幂等到账：条件认领 PaymentOrder（status pending→paid 的原子 CAS），认领成功才 walletBalanceCents +=
 * creditCents 并记 topup 台账；若 kind='purchase' 紧接着等额从余额出账并发放档位。重复回调因 CAS
 * count=0 而无副作用（幂等）。整体在一个事务内提交。
 */
export async function creditPaidOrder(
  outTradeNo: string,
  providerRef?: string
): Promise<CreditResult> {
  return prisma.$transaction(async (tx) => {
    const claim = await tx.paymentOrder.updateMany({
      where: { outTradeNo, status: 'pending' },
      data: {
        status: 'paid',
        paidAt: new Date(),
        ...(providerRef ? { providerRef } : {}),
      },
    });

    const order = await tx.paymentOrder.findUnique({ where: { outTradeNo } });
    if (!order) {
      return { ok: false, alreadyProcessed: false };
    }
    const meta = parseMeta(order.metadataJson);

    if (claim.count === 0) {
      // 未认领到：已被处理过（重复回调）或非 pending。幂等返回当前状态。
      return {
        ok: order.status === 'paid',
        alreadyProcessed: true,
        status: order.status,
        returnUrl: meta.returnUrl,
      };
    }

    // 认领成功 → 进账
    const creditCents = Math.max(0, Math.round(meta.creditCents ?? order.amountCents));
    const credited = await tx.user.update({
      where: { id: order.userId },
      data: { walletBalanceCents: { increment: creditCents } },
      select: { walletBalanceCents: true },
    });
    await tx.walletTransaction.create({
      data: {
        userId: order.userId,
        type: 'topup',
        amountCents: creditCents,
        balanceAfterCents: credited.walletBalanceCents,
        orderId: order.id,
      },
    });

    // 直接购买档位：等额出账 + 发放
    if (order.kind === 'purchase' && order.tierId) {
      await spendOnTierTx(tx, order.userId, order.tierId, { orderId: order.id });
    }

    return { ok: true, alreadyProcessed: false, status: 'paid', returnUrl: meta.returnUrl };
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
  await prisma.$transaction(async (tx) => {
    await spendOnTierTx(tx, userId, tierId, opts);
  });
}

/** 事务内：从余额扣款并发放档位（会员=改 role/到期；时间=加永久池）。 */
async function spendOnTierTx(
  tx: Prisma.TransactionClient,
  userId: string,
  tierId: string,
  opts: { operatorId?: string; orderId?: string }
): Promise<void> {
  const tier = await tx.rechargeTier.findUnique({ where: { id: tierId } });
  if (!tier || !tier.active) {
    throw new WalletError('档位不存在或已下架', 'tier_unavailable');
  }
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      walletBalanceCents: true,
      role: true,
      originalRole: true,
      roleExpiresAt: true,
    },
  });
  if (!user) throw new WalletError('用户不存在', 'user_not_found');
  if (user.walletBalanceCents < tier.priceCents) {
    throw new WalletError('钱包余额不足', 'insufficient_balance');
  }

  const decremented = await tx.user.update({
    where: { id: userId },
    data: { walletBalanceCents: { decrement: tier.priceCents } },
    select: { walletBalanceCents: true },
  });
  const balanceAfter = decremented.walletBalanceCents;

  if (tier.kind === 'membership') {
    if (user.role === 'ADMIN') {
      throw new WalletError('管理员无需购买会员', 'admin_no_membership');
    }
    const grantRole: UserRole = tier.grantRole ?? 'PRO';
    const days = Math.max(1, tier.durationDays ?? 30);
    const now = new Date();
    // 叠加续期：从「现有未过期到期日」或「现在」起算，取较晚者。
    const base =
      user.roleExpiresAt && user.roleExpiresAt > now ? user.roleExpiresAt : now;
    const newExpiry = new Date(base.getTime() + days * 86_400_000);
    // 到期回退目标：已在付费期（有 originalRole）则保留；否则记当前角色（若当前恰为 grantRole 则回退 FREE）。
    let originalRole: UserRole = user.originalRole ?? user.role;
    if (originalRole === grantRole) originalRole = 'FREE';
    const quotas = await resolveRoleQuotas(grantRole);
    const storageBytesLimit = await resolveRoleStorageBytesLimit(grantRole);
    await tx.user.update({
      where: { id: userId },
      data: {
        role: grantRole,
        originalRole,
        roleExpiresAt: newExpiry,
        // 购买系统角色会员即脱离自定义组，按角色默认配额（升配不触发 Model A 池结算）。
        customGroupId: null,
        transcriptionMinutesLimit: quotas.transcriptionMinutesLimit,
        storageHoursLimit: quotas.storageHoursLimit,
        allowedModels: quotas.allowedModels,
        storageBytesLimit,
        // 自增 tokenVersion 让旧 JWT 失效，下次请求按新角色重签发。
        tokenVersion: { increment: 1 },
      },
    });
    await tx.walletTransaction.create({
      data: {
        userId,
        type: 'purchase_membership',
        amountCents: -tier.priceCents,
        balanceAfterCents: balanceAfter,
        orderId: opts.orderId ?? null,
        tierId: tier.id,
        operatorId: opts.operatorId ?? null,
        note: `${tier.name}（${grantRole} ${days}天）`,
      },
    });
  } else if (tier.kind === 'minutes') {
    const minutes = Math.max(0, tier.grantMinutes ?? 0);
    await tx.user.update({
      where: { id: userId },
      data: { purchasedMinutesBalance: { increment: minutes } },
    });
    await tx.walletTransaction.create({
      data: {
        userId,
        type: 'purchase_minutes',
        amountCents: -tier.priceCents,
        balanceAfterCents: balanceAfter,
        minutesDelta: minutes,
        orderId: opts.orderId ?? null,
        tierId: tier.id,
        operatorId: opts.operatorId ?? null,
        note: `${tier.name}（+${minutes}分钟）`,
      },
    });
  } else {
    // topup 档位不应走「余额购买」路径。
    throw new WalletError('该档位不可用余额购买', 'tier_unavailable');
  }
}

/**
 * 管理员手动调整：余额（amountCentsDelta，有符号）和/或永久时长池（minutesDelta，有符号）。
 * 记 admin_adjust 台账（operatorId=操作管理员）。余额不可调至负数（截 0）。
 */
export async function adminAdjust(input: {
  userId: string;
  amountCentsDelta?: number;
  minutesDelta?: number;
  note?: string;
  operatorId: string;
}): Promise<void> {
  const amountDelta = Math.round(input.amountCentsDelta ?? 0);
  const minutesDelta = Math.round(input.minutesDelta ?? 0);
  if (amountDelta === 0 && minutesDelta === 0) {
    throw new WalletError('无调整内容', 'bad_request');
  }
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { walletBalanceCents: true },
    });
    if (!user) throw new WalletError('用户不存在', 'user_not_found');

    // 余额不减到负数：实际增量按当前余额截断。
    const effectiveAmountDelta =
      amountDelta < 0
        ? -Math.min(user.walletBalanceCents, -amountDelta)
        : amountDelta;

    const data: Prisma.UserUpdateInput = {};
    if (effectiveAmountDelta !== 0) {
      data.walletBalanceCents = { increment: effectiveAmountDelta };
    }
    if (minutesDelta !== 0) {
      // 池子不减到负数：用 GREATEST 护栏（raw），正向用 increment。
      if (minutesDelta > 0) {
        data.purchasedMinutesBalance = { increment: minutesDelta };
      }
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
    // 负向时长调整用 raw + GREATEST 防负。
    if (minutesDelta < 0) {
      await tx.$executeRaw`
        UPDATE User
        SET purchasedMinutesBalance = GREATEST(0, purchasedMinutesBalance - ${-minutesDelta})
        WHERE id = ${input.userId}
      `;
    }

    await tx.walletTransaction.create({
      data: {
        userId: input.userId,
        type: 'admin_adjust',
        amountCents: effectiveAmountDelta,
        balanceAfterCents: balanceAfter,
        minutesDelta: minutesDelta !== 0 ? minutesDelta : null,
        operatorId: input.operatorId,
        note: input.note ?? null,
      },
    });
  });
}
