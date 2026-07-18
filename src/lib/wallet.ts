import 'server-only';

import crypto from 'crypto';
import { Prisma, type UserRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { resolveRoleQuotas, resolveRoleStorageBytesLimit } from '@/lib/userRoles';
import { logSystemEvent } from '@/lib/auditLog';
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
 * 幂等到账。分两段事务，确保「钱已落袋」与「档位发放」解耦：
 *  - tx1：条件认领 PaymentOrder（pending→paid 原子 CAS），认领成功才 walletBalanceCents += creditCents
 *    并记 topup 台账。重复回调因 CAS count=0 无副作用（幂等）。
 *  - tx2（仅 purchase）：按订单**冻结的发放快照**等额出账 + 发放（不读 live 档位）。**发放失败绝不回滚
 *    tx1 的到账**——钱留在钱包余额（用户可改用余额购买），仅记 recharge.grant.failed 供人工处理，且回调
 *    仍据 tx1 成功回 ACK 让网关停止重试（H1）。快照冻结价与发放内容 → 无 credit/spend 价漂移（H2）。
 */
export async function creditPaidOrder(
  outTradeNo: string,
  providerRef?: string,
  expectedProvider?: PaymentProviderName,
  paidAmountCents?: number
): Promise<CreditResult> {
  // tx1：金额对账 → 认领 + 到账（钱先落袋，绝不因后续发放失败而回滚）。
  const claimed = await prisma.$transaction(async (tx) => {
    const order = await tx.paymentOrder.findUnique({ where: { outTradeNo } });
    if (!order) {
      return {
        order: null as null,
        meta: {} as OrderMetadata,
        claimedNow: false,
        amountMismatch: false,
      };
    }
    const meta = parseMeta(order.metadataJson);

    // 金额对账（M1/M2）：网关回报的实付金额须等于订单金额，否则拒绝到账（不认领，订单留 pending）。
    // 无金额的渠道（如 sandbox）paidAmountCents 为空 → 跳过。先读单不破坏幂等：认领仍以 status
    // pending→paid 的原子 updateMany 为唯一锚点，并发重复回调只有一个 count=1。
    if (
      typeof paidAmountCents === 'number' &&
      Math.round(paidAmountCents) !== order.amountCents
    ) {
      return { order, meta, claimedNow: false, amountMismatch: true };
    }

    const claim = await tx.paymentOrder.updateMany({
      // 绑定回调渠道到订单 provider（H3 纵深）：回调渠道须与下单渠道一致才认领，防止用某渠道
      // （尤其无验签的 sandbox）替另一渠道的订单结算。正常回调渠道恒等于下单渠道，不影响业务。
      where: {
        outTradeNo,
        status: 'pending',
        ...(expectedProvider ? { provider: expectedProvider } : {}),
      },
      data: {
        status: 'paid',
        paidAt: new Date(),
        ...(providerRef ? { providerRef } : {}),
      },
    });

    if (claim.count === 0) {
      // 未认领到：已被处理过（重复回调）或非 pending。幂等，不再到账。
      return { order, meta, claimedNow: false, amountMismatch: false };
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

    return { order, meta, claimedNow: true, amountMismatch: false };
  });

  const { order, meta } = claimed;
  if (!order) {
    return { ok: false, alreadyProcessed: false };
  }
  if (claimed.amountMismatch) {
    // 金额不符：拒绝到账，记录供排障（可能是攻击/网关不一致）。订单保持 pending。
    logSystemEvent(
      'recharge.callback.amount_mismatch',
      `outTradeNo=${outTradeNo} expected=${order.amountCents} paid=${paidAmountCents}`
    );
    return {
      ok: false,
      alreadyProcessed: false,
      status: order.status,
      returnUrl: meta.returnUrl,
    };
  }
  if (!claimed.claimedNow) {
    return {
      ok: order.status === 'paid',
      alreadyProcessed: true,
      status: order.status,
      returnUrl: meta.returnUrl,
    };
  }

  // tx2：purchase 订单按冻结快照发放（缺快照的旧订单回落读 live 档位）。发放失败不回滚到账。
  if (order.kind === 'purchase') {
    try {
      await prisma.$transaction(async (tx) => {
        const spec = meta.grant ?? (await resolveTierGrant(tx, order.tierId));
        if (!spec) {
          throw new WalletError('档位快照缺失且档位已不存在', 'tier_unavailable');
        }
        await applyGrantTx(tx, order.userId, spec, { orderId: order.id });
      });
    } catch (err) {
      // 已到账余额保留（钱不丢），仅记录以便人工补发/退款。网关据 tx1 成功照常收到 ACK、停止重试。
      const reason = err instanceof Error ? err.message : 'unknown';
      console.error(`购买发放失败，已到账余额保留（outTradeNo=${outTradeNo}）:`, err);
      logSystemEvent(
        'recharge.grant.failed',
        `outTradeNo=${outTradeNo} userId=${order.userId} reason=${reason}`
      );
    }
  }

  return { ok: true, alreadyProcessed: false, status: 'paid', returnUrl: meta.returnUrl };
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

/**
 * 事务内：按发放规格从余额扣款并发放（会员=改 role/到期；时间=加永久池）。
 * 规格可来自 live 档位（余额购买）或订单冻结快照（回调结算，H1/H2）。
 */
async function applyGrantTx(
  tx: Prisma.TransactionClient,
  userId: string,
  spec: GrantSnapshot,
  opts: { operatorId?: string; orderId?: string }
): Promise<void> {
  const priceCents = Math.max(0, Math.round(spec.priceCents));
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
    const grantRole: UserRole = spec.grantRole ?? 'PRO';
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
        amountCents: -priceCents,
        balanceAfterCents: balanceAfter,
        orderId: opts.orderId ?? null,
        tierId: spec.tierId,
        operatorId: opts.operatorId ?? null,
        note: `${spec.tierName}（${grantRole} ${days}天）`,
      },
    });
  } else {
    const minutes = Math.max(0, spec.grantMinutes ?? 0);
    await tx.user.update({
      where: { id: userId },
      data: { purchasedMinutesBalance: { increment: minutes } },
    });
    await tx.walletTransaction.create({
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
  }
}

/** 事务内：用余额购买 live 档位（校验未下架）。供余额购买与 admin 代购。 */
async function spendOnTierTx(
  tx: Prisma.TransactionClient,
  userId: string,
  tierId: string,
  opts: { operatorId?: string; orderId?: string }
): Promise<void> {
  const spec = await resolveTierGrant(tx, tierId);
  if (!spec) throw new WalletError('档位不存在或已下架', 'tier_unavailable');
  await applyGrantTx(tx, userId, spec, opts);
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
      select: { walletBalanceCents: true, purchasedMinutesBalance: true },
    });
    if (!user) throw new WalletError('用户不存在', 'user_not_found');

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
        minutesDelta: effectiveMinutesDelta !== 0 ? effectiveMinutesDelta : null,
        operatorId: input.operatorId,
        note: input.note ?? null,
      },
    });
  });
}
