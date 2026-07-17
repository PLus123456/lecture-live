import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  getBillableMinutes,
  getNextQuotaResetAt,
  getQuotaCycleStartAt,
  getRemainingTranscriptionMinutes,
} from '@/lib/billing';

/**
 * 可选 Prisma 客户端：默认用全局 `prisma`；调用方可传入事务客户端（`$transaction`
 * 的 tx），让配额窗口校验 + 扣减与外层事务在同一事务里原子提交。
 * PrismaClient 是 TransactionClient 的超集，故 `= prisma` 默认值类型相容。
 */
type QuotaDbClient = Prisma.TransactionClient;

type QuotaCheckType = 'transcription_minutes' | 'storage_hours' | 'storage_bytes';

type QuotaUserRecord = {
  id: string;
  role: 'ADMIN' | 'PRO' | 'FREE';
  transcriptionMinutesUsed: number;
  transcriptionMinutesLimit: number;
  // 充值系统（Model A）：购买的永久转录时长池（gross 余额，分钟）。月度免费额度用尽后自动动用。
  purchasedMinutesBalance: number;
  storageHoursUsed: number;
  storageHoursLimit: number;
  storageBytesUsed: bigint;
  storageBytesLimit: bigint;
  allowedModels: string;
  quotaResetAt: Date | null;
};

export interface UserQuotaSnapshot {
  id: string;
  role: 'ADMIN' | 'PRO' | 'FREE';
  transcriptionMinutesUsed: number;
  transcriptionMinutesLimit: number;
  // 购买的永久转录时长池余额（分钟）。remainingTranscriptionMinutes 已含它。
  purchasedMinutesBalance: number;
  remainingTranscriptionMinutes: number;
  remainingTranscriptionMs: number;
  storageHoursUsed: number;
  storageHoursLimit: number;
  storageBytesUsed: number;
  storageBytesLimit: number;
  remainingStorageBytes: number;
  allowedModels: string;
  quotaResetAt: Date | null;
}

/** ADMIN 配额视为无限 — 使用一个足够大的 sentinel 值（JSON 不支持 Infinity） */
const ADMIN_UNLIMITED_MINUTES = 999_999;
/** ADMIN bytes sentinel ≈ 1 TB，远小于 Number.MAX_SAFE_INTEGER (~9 PB)，可安全 JSON 序列化 */
const ADMIN_UNLIMITED_BYTES = 1_000_000_000_000;

/** 把外部传入的 amount 归一化为非负整数：NaN/Infinity/负数都视为 0 */
function normalizeNonNegativeAmount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.ceil(value)) : 0;
}

function toQuotaSnapshot(user: QuotaUserRecord): UserQuotaSnapshot {
  // Model A：剩余 = max(0, (limit + 购买池) − used)。购买池作为 gross 余额直接叠加在月度上限上，
  // 由 getRemainingTranscriptionMinutes(used, limit+purchased) 统一计算（内含 max(0, floor(·))）。
  const remainingTranscriptionMinutes =
    user.role === 'ADMIN'
      ? ADMIN_UNLIMITED_MINUTES
      : getRemainingTranscriptionMinutes(
          user.transcriptionMinutesUsed,
          user.transcriptionMinutesLimit + user.purchasedMinutesBalance
        );

  const storageBytesUsed = Number(user.storageBytesUsed);
  const storageBytesLimit = Number(user.storageBytesLimit);
  const remainingStorageBytes =
    user.role === 'ADMIN'
      ? ADMIN_UNLIMITED_BYTES
      : Math.max(0, storageBytesLimit - storageBytesUsed);

  return {
    id: user.id,
    role: user.role,
    transcriptionMinutesUsed: user.transcriptionMinutesUsed,
    transcriptionMinutesLimit: user.transcriptionMinutesLimit,
    purchasedMinutesBalance: user.purchasedMinutesBalance,
    remainingTranscriptionMinutes,
    remainingTranscriptionMs: remainingTranscriptionMinutes * 60_000,
    storageHoursUsed: user.storageHoursUsed,
    storageHoursLimit: user.storageHoursLimit,
    storageBytesUsed,
    storageBytesLimit,
    remainingStorageBytes,
    allowedModels: user.allowedModels,
    quotaResetAt: user.quotaResetAt,
  };
}

const QUOTA_USER_SELECT = {
  id: true,
  role: true,
  transcriptionMinutesUsed: true,
  transcriptionMinutesLimit: true,
  purchasedMinutesBalance: true,
  storageHoursUsed: true,
  storageHoursLimit: true,
  storageBytesUsed: true,
  storageBytesLimit: true,
  allowedModels: true,
  quotaResetAt: true,
} as const;

/**
 * Model A 池结算：算某用户「本周期已消费的购买时长池分钟」（owed），供月度重置时从 gross 池扣减。
 * owed = max(0, (used − 在途预留) − limit)。**必须排除在途预留**（async/full/grant reservedMinutes）：
 * 预留只是计入 used 的占位、尚未真正消费，会在下个周期结算时重新扣费——若把预留也算作已消费，
 * 会对同一批分钟重复扣池子。仅对持池用户（purchased>0）调用，其余用户 owed 恒 0、无需查询。
 */
async function computePoolOwed(
  userId: string,
  used: number,
  limit: number,
  db: QuotaDbClient
): Promise<number> {
  const sessionAgg = await db.session.aggregate({
    where: { userId },
    _sum: { asyncReservedMinutes: true, fullReservedMinutes: true },
  });
  const grantAgg = await db.sonioxStreamGrant.aggregate({
    where: { userId, settledAt: null },
    _sum: { reservedMinutes: true },
  });
  const inflight =
    (sessionAgg._sum.asyncReservedMinutes ?? 0) +
    (sessionAgg._sum.fullReservedMinutes ?? 0) +
    (grantAgg._sum.reservedMinutes ?? 0);
  const committedUsed = Math.max(0, used - inflight);
  return Math.max(0, committedUsed - Math.max(0, limit));
}

async function ensureQuotaWindow(
  userId: string,
  now = new Date(),
  db: QuotaDbClient = prisma
): Promise<QuotaUserRecord | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: QUOTA_USER_SELECT,
  });

  if (!user) {
    return null;
  }

  // 首次：初始化配额窗口
  if (user.quotaResetAt == null) {
    return db.user.update({
      where: { id: userId },
      data: {
        quotaResetAt: getNextQuotaResetAt(now),
      },
      select: QUOTA_USER_SELECT,
    });
  }

  // 未过期：直接返回
  if (user.quotaResetAt > now) {
    return user;
  }

  // 充值系统（Model A）：在清预留 + 归零 used 之前，先算持池用户本周期已消费的池子分钟（owed），
  // 稍后随重置从 gross 池扣减。owed 用**清空前**的预留快照并排除在途预留（见 computePoolOwed）。
  const poolOwed =
    user.purchasedMinutesBalance > 0
      ? await computePoolOwed(
          userId,
          user.transcriptionMinutesUsed,
          user.transcriptionMinutesLimit,
          db
        )
      : 0;

  // B1（防跨周期二次释放，审查 R1）：**先清**该用户在途预留列，**再**把 used 归零。
  // 顺序是关键——若先归零 used 再清列，两条非事务 updateMany 之间会出现「used=0 但 col=est」的
  // 窗口，让并发 finalize 的 settle 读到未清的 est 二次释放、把新周期真实扣费抹掉（用 GREATEST 截 0
  // → 完成的转录白扣 0）。先清列则该坏窗口不存在：settle 只会读到已清的 0、不释放。
  // db 为事务客户端时两条本就同事务原子提交、顺序无碍；db 为普通 client 时靠此顺序消除坏窗口。
  // 无条件清（本分支已确定 quotaResetAt<=now 过期）：即便随后乐观锁重置输给并发请求(count=0)，
  // 对方也会同样重置 used→0，预留作废、清列正确且幂等。
  // R4：异步上传(asyncReservedMinutes)与完整版补全(fullReservedMinutes)两类在途预留一并清 —— 二者
  // 都计入 transcriptionMinutesUsed，used 归零即两笔预留同时作废。一条 updateMany 原子清两列。
  await db.session.updateMany({
    where: {
      userId,
      OR: [
        { asyncReservedMinutes: { gt: 0 } },
        { fullReservedMinutes: { gt: 0 } },
      ],
    },
    data: { asyncReservedMinutes: 0, fullReservedMinutes: 0 },
  });

  // R1-L2：Soniox 串流 grant 的在途预留同理——预留计入 transcriptionMinutesUsed，used 归零即预留
  // 作废，先把未结 grant 的 reservedMinutes 清零（同上，先清列再归零 used，消除并发 settle 读到
  // 未清预留二次释放的坏窗口）。grant 本身保持未结：跨月仍在串的流照常由 finalize/deduct/usage-cron
  // 结算（届时释放 0），孤儿有用量照常按 actualMs 转扣——只作废预留、不作废计费。
  await db.sonioxStreamGrant.updateMany({
    where: { userId, settledAt: null, reservedMinutes: { gt: 0 } },
    data: { reservedMinutes: 0 },
  });

  const nextResetAt = getNextQuotaResetAt(now);

  // 持池用户（poolOwed>0）：原子「归零 used + 推进窗口 + 扣 gross 池 owed」。乐观锁 WHERE
  // quotaResetAt<=now 保证并发下只有一个请求真正执行（另一个 affectedRows=0、不重复扣池），
  // GREATEST 防负（门禁保证 owed<=purchased，护栏兜底）。
  if (poolOwed > 0) {
    await db.$executeRaw`
      UPDATE User
      SET purchasedMinutesBalance = GREATEST(0, purchasedMinutesBalance - ${poolOwed}),
          transcriptionMinutesUsed = 0,
          quotaResetAt = ${nextResetAt}
      WHERE id = ${userId} AND quotaResetAt <= ${now}
    `;
    return db.user.findUnique({
      where: { id: userId },
      select: QUOTA_USER_SELECT,
    });
  }

  // 已过期（无池或本周期未动用池）：用乐观锁重置，防止并发请求同时重置清零刚扣的配额
  const resetResult = await db.user.updateMany({
    where: {
      id: userId,
      quotaResetAt: { lte: now },
    },
    data: {
      transcriptionMinutesUsed: 0,
      quotaResetAt: nextResetAt,
    },
  });

  if (resetResult.count === 0) {
    // 另一个请求已经完成了重置，重新读取最新值
    return db.user.findUnique({
      where: { id: userId },
      select: QUOTA_USER_SELECT,
    });
  }

  // 重置成功，返回最新值
  return db.user.findUnique({
    where: { id: userId },
    select: QUOTA_USER_SELECT,
  });
}

export async function getQuotaSnapshot(
  userId: string
): Promise<UserQuotaSnapshot | null> {
  const user = await ensureQuotaWindow(userId);
  return user ? toQuotaSnapshot(user) : null;
}

/**
 * 实时计算某用户已用的"录音存储小时"。
 *
 * 口径：SUM(session.durationMs)/3600000，覆盖该用户全部 session。删录音即删 Session 行
 *（见 DELETE /api/sessions/[id]，整行级联删除，无"删录音留行"路径），故对剩余行求和即为
 * 当前真实占用——天然随删除回落、无漂移，也无须 increment 维护 storageHoursUsed 列。
 *
 * 注意：与按月重置的 transcriptionMinutesUsed 不同，录音存储是累计占用、不随配额周期重置，
 * 因此这里不按 quotaResetAt 截断，聚合全部历史 session。
 */
export async function getStorageHoursUsed(
  userId: string,
  db: QuotaDbClient = prisma
): Promise<number> {
  const agg = await db.session.aggregate({
    where: { userId },
    _sum: { durationMs: true },
  });
  const totalMs = agg._sum.durationMs ?? 0;
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return 0;
  }
  return totalMs / 3_600_000;
}

export async function checkQuota(
  userId: string,
  type: QuotaCheckType
): Promise<boolean> {
  const user = await getQuotaSnapshot(userId);
  if (!user) {
    return false;
  }

  if (user.role === 'ADMIN') {
    return true;
  }

  switch (type) {
    case 'transcription_minutes':
      // Model A：月度上限 + 购买的永久时长池都算可用额度。
      return (
        user.transcriptionMinutesUsed <
        user.transcriptionMinutesLimit + user.purchasedMinutesBalance
      );
    case 'storage_hours': {
      // storageHoursUsed 列从不 increment（死维度）；实时用 SUM(durationMs)/3600000 作为
      // 已用量，与 storageHoursLimit 比较。这样删录音后占用自动回落，杜绝"恒 0<limit 恒真"。
      const usedHours = await getStorageHoursUsed(userId);
      return usedHours < user.storageHoursLimit;
    }
    case 'storage_bytes':
      return user.storageBytesUsed < user.storageBytesLimit;
    default:
      return false;
  }
}

/**
 * 扣减转录分钟（finalize / 异步上传 / interpret 共用）。
 *
 * 内部先 `ensureQuotaWindow` 做跨月度重置点的窗口校正，再 increment —— 保证扣减
 * 总是落在正确的当月窗口（裸 increment 会在跨月时把分钟加到未重置的旧窗口，造成隐性 drift）。
 *
 * @param db 可选事务客户端。实时 finalize 传入 `$transaction` 的 tx，使"扣减 ⟺ session
 *   置 COMPLETED"在同一事务原子提交（失败一起回滚，杜绝并发/重试双扣或漏扣）。
 */
export async function deductTranscriptionMinutes(
  userId: string,
  minutes: number,
  db: QuotaDbClient = prisma
): Promise<UserQuotaSnapshot | null> {
  const user = await ensureQuotaWindow(userId, new Date(), db);
  if (!user) {
    return null;
  }

  if (user.role === 'ADMIN') {
    return toQuotaSnapshot(user);
  }

  const normalizedMinutes = normalizeNonNegativeAmount(minutes);

  if (normalizedMinutes <= 0) {
    return toQuotaSnapshot(user);
  }

  const updated = await db.user.update({
    where: { id: userId },
    data: {
      transcriptionMinutesUsed: {
        increment: normalizedMinutes,
      },
    },
    select: QUOTA_USER_SELECT,
  });

  return toQuotaSnapshot(updated);
}

/**
 * 记录一笔同声传译用量台账（/api/interpret/deduct 成功扣费后调用）。
 *
 * interpret 扣费只 increment transcriptionMinutesUsed、不产生 Session 行，对账无从按 Session
 * 重算这部分用量。此表把每次已扣的分钟持久化，供 reconcileTranscriptionUsage 把 interpret
 * 用量计入 expected（消除对同传用户的虚报 drift）。
 *
 * @param minutes 本次实扣分钟，口径必须与 deduct 侧一字一致（billableMinutes）。
 * @param durationMs 本次计费时长（effectiveMs），可选，仅作审计参考。
 *
 * 只增不减、天然幂等：deduct 已是一次性锚点消费，同一次会话不会重复扣费/记账。
 */
export async function recordInterpretUsage(
  userId: string,
  minutes: number,
  durationMs?: number,
  db: QuotaDbClient = prisma
): Promise<void> {
  const normalizedMinutes = normalizeNonNegativeAmount(minutes);
  if (normalizedMinutes <= 0) {
    return;
  }

  const normalizedDurationMs =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
      ? Math.trunc(durationMs)
      : null;

  await db.interpretUsage.create({
    data: {
      userId,
      billedMinutes: normalizedMinutes,
      durationMs: normalizedDurationMs,
    },
  });
}

export async function resetExpiredTranscriptionQuotas(
  now = new Date()
): Promise<number> {
  const nextResetAt = getNextQuotaResetAt(now);

  // 乐观锁条件重置（对齐 ensureQuotaWindow 的 updateMany WHERE quotaResetAt<=now）：
  // 单条原子 updateMany 取代"先 findMany 再逐个无条件 update"。无条件 update 会与请求
  // 路径上的 ensureQuotaWindow / 扣费在毫秒级并发时互相覆写——把刚被重置并扣过费的窗口
  // 再次清零（白送额度）。以 updateMany 的 count 为返回值，且消除 findMany→update 的 TOCTOU。
  // B1（防跨周期二次释放，审查 R1）：先记下将被重置的用户，**先清**其在途预留列，**再**把 used
  // 归零。顺序同 ensureQuotaWindow——先归零 used 再清列会留下「used=0 但 col=est」窗口，让并发
  // finalize 的 settle 二次释放把新周期真实扣费抹掉。先清列则 settle 只会读到已清的 0。
  // 残留的极窄 TOCTOU（findMany 与清列之间某用户新建预留被误清）只会让该新预留永久留在 used
  // （过量计费、对用户不利、非白送），且会在下一周期重置自愈——远小于跨周期二次释放（漏收费）的危害，可接受。
  // R4：异步上传与完整版补全两类在途预留一并清（一条 updateMany 原子清两列，见 ensureQuotaWindow）。
  // 充值系统（Model A）：持池用户先逐个原子结算——按 owed 从 gross 池扣本周期已用溢出，同时归零 used、
  // 推进窗口。必须在批量重置前做（owed 用清空前的预留快照算）；结算成功者 quotaResetAt 已推进，
  // 自然被后续批量 WHERE quotaResetAt<=now 排除，不重复处理。持池用户很少，逐个成本可忽略。
  let poolResetCount = 0;
  const poolHolders = await prisma.user.findMany({
    where: { quotaResetAt: { lte: now }, purchasedMinutesBalance: { gt: 0 } },
    select: {
      id: true,
      transcriptionMinutesUsed: true,
      transcriptionMinutesLimit: true,
    },
  });
  for (const ph of poolHolders) {
    const owed = await computePoolOwed(
      ph.id,
      ph.transcriptionMinutesUsed,
      ph.transcriptionMinutesLimit,
      prisma
    );
    // 先清该用户在途预留列（与 ensureQuotaWindow 同序：先清列再归零 used，防跨周期二次释放）。
    await prisma.session.updateMany({
      where: {
        userId: ph.id,
        OR: [
          { asyncReservedMinutes: { gt: 0 } },
          { fullReservedMinutes: { gt: 0 } },
        ],
      },
      data: { asyncReservedMinutes: 0, fullReservedMinutes: 0 },
    });
    await prisma.sonioxStreamGrant.updateMany({
      where: { userId: ph.id, settledAt: null, reservedMinutes: { gt: 0 } },
      data: { reservedMinutes: 0 },
    });
    const affected = await prisma.$executeRaw`
      UPDATE User
      SET purchasedMinutesBalance = GREATEST(0, purchasedMinutesBalance - ${owed}),
          transcriptionMinutesUsed = 0,
          quotaResetAt = ${nextResetAt}
      WHERE id = ${ph.id} AND quotaResetAt <= ${now}
    `;
    if (affected === 1) poolResetCount += 1;
  }

  const expiredUsers = await prisma.user.findMany({
    where: { quotaResetAt: { lte: now } },
    select: { id: true },
  });

  if (expiredUsers.length > 0) {
    await prisma.session.updateMany({
      where: {
        userId: { in: expiredUsers.map((u) => u.id) },
        OR: [
          { asyncReservedMinutes: { gt: 0 } },
          { fullReservedMinutes: { gt: 0 } },
        ],
      },
      data: { asyncReservedMinutes: 0, fullReservedMinutes: 0 },
    });
  }

  const result = await prisma.user.updateMany({
    where: {
      quotaResetAt: { lte: now },
    },
    data: {
      transcriptionMinutesUsed: 0,
      quotaResetAt: nextResetAt,
    },
  });

  return poolResetCount + result.count;
}

/**
 * 充值系统（Model A）：**下调 transcriptionMinutesLimit 时**结算购买时长池（对持池用户）。
 *
 * 背景：Model A 用 overflow = max(0, used − limit) 表示「本周期已动用的池子分钟」，仅在 limit 恒定时成立。
 * 若把 limit 调低而不动 used（角色到期降级 / 用户组同步 / admin 改角色配额都这么做），used 会瞬间远超
 * 新 limit：既让下次月度重置把「旧 limit 下本属免费的消费」误算成池子消费（甚至清零池子），又让对账
 *（used 应等于本周期总消费）与「used 被人为压低」相矛盾而虚报 drift。
 *
 * 处理（仅当 used > newLimit 的持池用户）：按**旧 limit** 结算真实池子消费（purchased -= max(0, used − oldLimit)），
 * 并**整周期重置**——used→0 且推进 quotaResetAt。整周期重置让对账的 cycleStart 越过本周期已计费 session、
 * used 归 0 ⇒ drift 恒 0（不触发误报→admin「修复」→下次重置过量扣池的连锁），同时从根上消除「limit 中途
 * 变化令 used 与 overflow 脱钩」的误扣。代价是被降级/降配的持池用户获得一份新的当期免费额度（轻微慷慨、
 * 事件罕见，可接受）。newLimit >= oldLimit（升配/不变）无需处理；used<=newLimit 时无 false overflow、
 * 池子也未动用，亦为 no-op（WHERE 过滤）。仅作用于持池用户（purchasedMinutesBalance>0），无池用户保持既有
 *「usage 不动」行为。
 *
 * 实现见 settlePoolOnLimitChangeTx：owed 排除在途预留（async/full/grant），先清预留列再整周期重置扣池。
 */
export async function settlePoolOnLimitChange(
  userId: string,
  oldLimit: number,
  newLimit: number,
  db: QuotaDbClient = prisma
): Promise<void> {
  if (!Number.isFinite(oldLimit) || !Number.isFinite(newLimit)) return;
  if (newLimit >= oldLimit) return;
  // 结算涉及「读 used → 排除在途预留算 owed → 清预留列 → 整周期重置扣池」多表多语句，必须原子。
  // 传入基础客户端（有 $transaction）时自包一层事务；已是事务客户端（无 $transaction）时直接执行。
  const maybeTx = db as {
    $transaction?: (fn: (tx: QuotaDbClient) => Promise<void>) => Promise<void>;
  };
  if (typeof maybeTx.$transaction === 'function') {
    await maybeTx.$transaction((tx) =>
      settlePoolOnLimitChangeTx(tx, userId, oldLimit, newLimit)
    );
  } else {
    await settlePoolOnLimitChangeTx(db, userId, oldLimit, newLimit);
  }
}

/**
 * settlePoolOnLimitChange 的事务体（须在事务内运行）：
 *  1) 读当前 used/pool，仅对持池（purchased>0）且 used>新上限者结算；
 *  2) owed = max(0, (used − 在途预留) − 旧上限)——**排除在途预留**（与月度重置同口径 computePoolOwed）。
 *     否则把 async/full/grant 里尚未真正消费的预留也当作已消费扣进池子（Q_HIGH 幻扣：上传失败即凭空扣池）；
 *  3) **先清**在途预留列（async/full session + 未结 grant）再归零 used（与 ensureQuotaWindow 同序）。
 *     否则悬空预留会在后续 finalize/settle 时对新周期真实用量二次释放、把完成的转录白扣成 0（Q_HIGH 免费分钟）；
 *  4) 整周期重置：扣 owed（GREATEST 防负）+ used 归零 + 推进 quotaResetAt。
 */
async function settlePoolOnLimitChangeTx(
  db: QuotaDbClient,
  userId: string,
  oldLimit: number,
  newLimit: number
): Promise<void> {
  const oldLim = Math.max(0, Math.floor(oldLimit));
  const newLim = Math.max(0, Math.floor(newLimit));

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { transcriptionMinutesUsed: true, purchasedMinutesBalance: true },
  });
  if (!user || user.purchasedMinutesBalance <= 0) return;
  // used 未超新上限：无 false overflow、池子本周期也未动用 → no-op（与旧 WHERE 语义一致）。
  if (user.transcriptionMinutesUsed <= newLim) return;

  // owed 用**清预留前**的快照、并排除在途预留计算（否则重复扣池）。
  const owed = await computePoolOwed(
    userId,
    user.transcriptionMinutesUsed,
    oldLim,
    db
  );

  const now = new Date();
  const nextResetAt = getNextQuotaResetAt(now);

  // 先清预留列、再归零 used：消除并发 settle/finalize 读到未清预留二次释放的坏窗口（同月度重置）。
  await db.session.updateMany({
    where: {
      userId,
      OR: [
        { asyncReservedMinutes: { gt: 0 } },
        { fullReservedMinutes: { gt: 0 } },
      ],
    },
    data: { asyncReservedMinutes: 0, fullReservedMinutes: 0 },
  });
  await db.sonioxStreamGrant.updateMany({
    where: { userId, settledAt: null, reservedMinutes: { gt: 0 } },
    data: { reservedMinutes: 0 },
  });

  // 整周期重置 + 记结算下界 transcriptionUsageReconcileFrom=now（Q_MED）：used 周期中途归零后，
  // 对账窗口 cycleStart 仍月对齐指向月初，会把结算前已计费 session 误报为 drift；此下界让 reconcile
  // 用 max(cycleStart, now) 截断、排除结算前 session，杜绝虚报（→admin 误“修正”→过量扣池）。
  await db.$executeRaw`
    UPDATE User
    SET purchasedMinutesBalance = GREATEST(0, purchasedMinutesBalance - ${owed}),
        transcriptionMinutesUsed = 0,
        quotaResetAt = ${nextResetAt},
        transcriptionUsageReconcileFrom = ${now}
    WHERE id = ${userId}
      AND purchasedMinutesBalance > 0
      AND transcriptionMinutesUsed > ${newLim}
  `;
}

/**
 * 充值系统（Model A）：给用户的购买时长池加分钟（买时间到账）。gross 池只在此处与月度重置结算两处变更。
 * 应在钱包结算事务内调用（与扣余额同事务）；随 PaymentOrder 认领的 pending→paid CAS 幂等，不会重复到账。
 */
export async function grantPurchasedMinutes(
  userId: string,
  minutes: number,
  db: QuotaDbClient = prisma
): Promise<void> {
  const normalized = normalizeNonNegativeAmount(minutes);
  if (normalized <= 0) return;
  await db.user.update({
    where: { id: userId },
    data: { purchasedMinutesBalance: { increment: normalized } },
  });
}

/**
 * 对账：按已完成 session 的实际时长重算应扣分钟，与 transcriptionMinutesUsed 比对。
 *
 * @param asyncMultiplier 异步上传转录的计费倍率（默认 1）。异步路径按倍率计费
 *   （见 async-transcribe-status 扣费），对账侧必须乘同样倍率，否则会把折扣恒报成 drift。
 *   实时转录始终全额（不乘倍率）。
 *
 * U15（口径修正）：排除 ADMIN 用户。扣费侧对 ADMIN 恒短路不扣（deduct/reserve 见 role==='ADMIN'
 * 分支），故 ADMIN 的 transcriptionMinutesUsed 恒为 0，而本函数会按其 COMPLETED session 重算出
 * 非 0 的 recordedMinutes → 每次对账都对 ADMIN 永久虚报正向 drift（且"修复"会把 used 写成
 * recorded，破坏 ADMIN 无限额度语义）。用 WHERE role != ADMIN 从源头排除。
 *
 * interpret 口径（v3-R8 补完，原 U15 延后项）：同声传译（/api/interpret/deduct）扣费会
 * increment transcriptionMinutesUsed，但不产生任何 Session 行。此前本函数仅按 Session 重算，
 * 故用过同传的用户被虚报负向 drift。现引入持久化台账 InterpretUsage（deduct 成功后记一笔，
 * billedMinutes 与实扣一字一致），本函数把当前对账周期内该用户的 InterpretUsage.billedMinutes
 * 之和加入 expected（周期口径与 Session 侧一致：均按 quotaResetAt 窗口 [cycleStart, ...) 截断）。
 * 于是 expected = session 分钟 + interpret 分钟，drift = expected − transcriptionMinutesUsed
 * 对纯同传用户回归 0，消除虚报。
 *
 * 完整版补全转录口径（B6 补完）：完整版补全转录（fullTranscribeStatus）在实时/异步上传扣费之上
 * 额外扣一笔 ceil(getBillableMinutes(durationMs) × asyncMultiplier)（见 fullTranscribeFinalize）。
 * 此前 expected 完全不含这笔——凡完成过完整版补全转录的用户每轮对账都被虚报负向 drift，且据此
 * 「修复」会把这笔真实扣费退掉。现对 fullTranscribeStatus==='completed' 的 session 按同一确定性
 * 口径（与扣费侧一字一致）计入 expected，消除虚报。完整版扣费是确定性的（由 durationMs 唯一决定），
 * 故无须像 interpret 那样引入台账，直接按 completed 状态重算即可。
 */
export async function reconcileTranscriptionUsage(asyncMultiplier = 1) {
  const users = await prisma.user.findMany({
    where: {
      // ADMIN 恒不扣费，重算必永久虚报 drift —— 从对账源头排除
      role: { not: 'ADMIN' },
    },
    select: {
      id: true,
      email: true,
      transcriptionMinutesUsed: true,
      quotaResetAt: true,
      transcriptionUsageReconcileFrom: true,
    },
  });

  const results = await Promise.all(
    users.map(async (user) => {
      const monthCycleStart = getQuotaCycleStartAt(user.quotaResetAt);
      // Q_MED：限额下调结算会在周期中途把 used 归零并记 transcriptionUsageReconcileFrom；用它作为
      // 对账下界（取较晚者），排除结算前已计费的 session，避免虚报 drift。正常情况下该列为空或早于
      // 月对齐的 cycleStart，max 使其无影响；月度重置后 cycleStart 自然越过它而失效（无需清列）。
      const cycleStart =
        user.transcriptionUsageReconcileFrom &&
        user.transcriptionUsageReconcileFrom > monthCycleStart
          ? user.transcriptionUsageReconcileFrom
          : monthCycleStart;

      const sessions = await prisma.session.findMany({
        where: {
          userId: user.id,
          status: 'COMPLETED',
          // B7：按扣费时刻(billedAt)归期，而非 createdAt。跨月/延迟收尾/自动回收的会话，扣费落在
          // finalize 时的配额窗口(ensureQuotaWindow 按 quotaResetAt)，用 createdAt 归期会把它算错周期、
          // 虚报 drift。billedAt 为空(未扣费/ADMIN/pre-B7 老数据)时回退 createdAt，保持旧行为。
          OR: [
            { billedAt: { gte: cycleStart } },
            { billedAt: null, createdAt: { gte: cycleStart } },
          ],
        },
        select: {
          durationMs: true,
          asyncTranscribeStatus: true,
          fullTranscribeStatus: true,
        },
      });

      const sessionMinutes = sessions.reduce((total, session) => {
        if (!session.durationMs || session.durationMs <= 0) {
          return total;
        }
        const billable = getBillableMinutes(session.durationMs);
        // 异步上传转录（asyncTranscribeStatus 非空）按倍率，实时转录全额。
        // 与扣费侧 ceil(分钟×倍率) 完全一致，保证折扣不被误报为 drift。
        const transcribeCharged =
          session.asyncTranscribeStatus != null
            ? Math.ceil(billable * asyncMultiplier)
            : billable;
        // 完整版补全转录（fullTranscribeStatus==='completed'）是叠加在实时/异步转录之上的
        // 额外一笔扣费，口径 ceil(分钟×倍率)，与 fullTranscribeFinalize 扣费侧一字一致（B6）。
        // 未完成态（transcribing/finalizing/pending/failed 等）尚未扣费，计 0。
        const fullCharged =
          session.fullTranscribeStatus === 'completed'
            ? Math.ceil(billable * asyncMultiplier)
            : 0;
        return total + transcribeCharged + fullCharged;
      }, 0);

      // 同传用量：当前对账周期内该用户已扣的 interpret 分钟之和（口径与扣费侧一字一致，
      // 直接对已落库的 billedMinutes 求和；不做倍率——interpret 恒全额扣，无异步折扣）。
      // 周期窗口与 Session 侧一致：chargedAt >= cycleStart。
      const interpretAgg = await prisma.interpretUsage.aggregate({
        where: {
          userId: user.id,
          chargedAt: { gte: cycleStart },
        },
        _sum: { billedMinutes: true },
      });
      const interpretMinutes = interpretAgg._sum.billedMinutes ?? 0;

      // R1-L2：usage cron 经 grant 直接补扣的分钟（孤儿转扣/迟到补扣）不走 Session 也不走
      // InterpretUsage，台账就是 grant 行本身（billedMinutes，settledAt=扣费时刻）。不计入则凡被
      // 兜底扣过的用户恒报负 drift、按报表「修复」会把真实扣费退掉（B6 同款教训）。周期口径一致：
      // settledAt >= cycleStart。
      const grantAgg = await prisma.sonioxStreamGrant.aggregate({
        where: {
          userId: user.id,
          settledAt: { gte: cycleStart },
          billedMinutes: { gt: 0 },
        },
        _sum: { billedMinutes: true },
      });
      const grantMinutes = grantAgg._sum.billedMinutes ?? 0;

      const expectedMinutes = sessionMinutes + interpretMinutes + grantMinutes;

      return {
        id: user.id,
        email: user.email,
        recordedMinutes: expectedMinutes,
        transcriptionMinutesUsed: user.transcriptionMinutesUsed,
        driftMinutes: expectedMinutes - user.transcriptionMinutesUsed,
      };
    })
  );

  return results.filter((entry) => entry.driftMinutes !== 0);
}

/**
 * 字节配额对账：用 ChatAttachment 的真实 SUM(bytes) 回写每个用户的 storageBytesUsed。
 *
 * 与转录对账（只记录差异、不自动修）不同，字节用量完全由 ChatAttachment 行决定、是确定性的，
 * 因此这里直接回写自愈：删录音漏扣 / 上传中断漏扣 / 并发偏差等都会被校准。无附件的用户若残留
 * 非零计数也会被清零。返回检查与修正的用户数。
 */
export async function reconcileStorageBytes(): Promise<{
  checked: number;
  corrected: number;
}> {
  const sums = await prisma.chatAttachment.groupBy({
    by: ['userId'],
    _sum: { bytes: true },
  });
  const sumByUser = new Map<string, bigint>();
  for (const row of sums) {
    sumByUser.set(row.userId, row._sum.bytes ?? BigInt(0));
  }

  const users = await prisma.user.findMany({
    select: { id: true, storageBytesUsed: true },
  });

  let corrected = 0;
  for (const user of users) {
    const actual = sumByUser.get(user.id) ?? BigInt(0);
    if (actual !== user.storageBytesUsed) {
      await prisma.user.update({
        where: { id: user.id },
        data: { storageBytesUsed: actual },
      });
      corrected += 1;
    }
  }
  return { checked: users.length, corrected };
}

/**
 * 契约6（P1-13）—— 录音存储小时（storageHoursLimit）的强约束原语。async-upload init /
 * full-transcribe 入口（本 BACKEND track）与录音入口（ROUTES track：audio POST / draft 首次 /
 * finalize 结算）**按同名同签**调用这三个函数，保证两边口径一致。
 *
 * 存储口径：storageHoursUsed 列是死维度（从不 increment），真实占用由 SUM(session.durationMs)/
 * 3600000 实时算（getStorageHoursUsed）。删录音即删 Session 行、占用自动回落。于是「存储小时」天然
 * 由 durationMs 这一**确定性台账**承载——settle 即调用方把真实 durationMs 落到 session（本就会做），
 * release 即删 session（本就会做）。因此在**不改 schema** 的前提下无须新增独立预留列。
 *
 * 代价（契约6 明示允许的「非原子降级」）：没有独立预留列 → reserve 是**读时校验**（读当前 SUM 占用
 * + 本次预估，判 <= limit），非完全原子。并发多个入口可能同时通过读检查、叠加后轻微超限；但存储小时
 * 是累计成本护栏（非硬性安全边界），下一次入口/对账会读到真实占用而收敛，危害可接受。
 */

/**
 * 读时校验预留存储分钟。超限返回 ok:false（**不抛**）。
 *
 * @param sessionId 保留在签名里以对齐契约6 固定签名、便于将来升级为持久 per-session 预留；当前降级实现
 *   不按 session 落预留，仅按用户维度读时校验。
 * @param estimatedMinutes 本次将新增占用的录音分钟（async 上传按声明时长投影；realtime 录音入口按预估）。
 * @returns { ok, remaining } remaining 为当前剩余可用分钟（floor）。
 */
export async function reserveStorageMinutes(
  userId: string,
  sessionId: string,
  estimatedMinutes: number
): Promise<{ ok: boolean; remaining: number }> {
  void sessionId; // 降级实现未按 session 持久化预留（见上方注释）；保留形参以对齐契约6 签名
  const user = await getQuotaSnapshot(userId);
  if (!user) {
    return { ok: false, remaining: 0 };
  }
  if (user.role === 'ADMIN') {
    return { ok: true, remaining: ADMIN_UNLIMITED_MINUTES };
  }

  const limitHours = user.storageHoursLimit;
  const usedHours = await getStorageHoursUsed(userId);
  const estMinutes = normalizeNonNegativeAmount(estimatedMinutes);
  const estHours = estMinutes / 60;
  const remainingMinutes = Math.max(0, Math.floor((limitHours - usedHours) * 60));
  // 读时校验：当前真实占用 + 本次预估 <= 上限才放行。
  const ok = usedHours + estHours <= limitHours;
  return { ok, remaining: remainingMinutes };
}

/**
 * 结算一笔存储预留（契约6）。SUM(durationMs) 口径下，调用方把真实 durationMs 落到 session 本身
 * 即为结算——SUM 会自动反映真实占用。故此处为**有意的 no-op**（保留 API 以对齐契约6 签名、并给
 * 将来升级为持久预留列留接缝）。参数仅作审计语义，不落库。
 */
export async function settleStorageMinutes(
  sessionId: string,
  actualMinutes: number
): Promise<void> {
  void sessionId;
  void actualMinutes;
  // SUM(durationMs) 模型下，durationMs 的写入（调用方负责）即结算，无独立预留列可清。
}

/**
 * 释放一笔未落地的存储预留（契约6）。SUM(durationMs) 口径下，删 Session 行即释放占用；未写
 * durationMs 的失败入口天然不计入 SUM。故此处为**有意的 no-op**（保留 API 以对齐契约6 签名）。
 */
export async function releaseStorageMinutes(sessionId: string): Promise<void> {
  void sessionId;
  // SUM(durationMs) 模型下，删 session / 未写 durationMs 即释放，无独立预留列可清。
}

export function isModelAllowed(
  user: { allowedModels: string; role: string },
  modelName: string
): boolean {
  if (user.role === 'ADMIN') return true;
  if (user.allowedModels === '*') return true;
  return user.allowedModels
    .split(',')
    .map((m) => m.trim())
    .includes(modelName);
}

/**
 * 在用户的 storageBytesUsed 上加增量（用于 chat 上传文件 / 录音文件计费）。
 * 输入 bytes 是 JS number；内部转 BigInt 落库。ADMIN 不扣减但仍返回最新 snapshot。
 */
export async function addStorageBytes(
  userId: string,
  bytes: number
): Promise<UserQuotaSnapshot | null> {
  const user = await ensureQuotaWindow(userId);
  if (!user) return null;
  if (user.role === 'ADMIN') return toQuotaSnapshot(user);

  const normalized = normalizeNonNegativeAmount(bytes);
  if (normalized <= 0) return toQuotaSnapshot(user);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      storageBytesUsed: { increment: BigInt(normalized) },
    },
    select: QUOTA_USER_SELECT,
  });
  return toQuotaSnapshot(updated);
}

/**
 * 原子预留字节配额（用于 chat 上传前的"先占额度"）。
 *
 * 与 addStorageBytes 的区别：这是**条件原子**扣减——只有当 `used + bytes <= limit`
 * 时才真正写库并返回 true；否则不写库、返回 false。用一条 `UPDATE ... WHERE` 完成
 * 校验+扣减，杜绝"先 checkQuota 再 addStorageBytes"之间的并发击穿（多个上传同时
 * 通过非原子检查、叠加后超额）。
 *
 * ADMIN 视为无限：直接放行、不写库、返回 true。
 * 调用方在后续步骤失败时应调用 releaseStorageBytes 回滚预留的额度。
 */
export async function reserveStorageBytes(
  userId: string,
  bytes: number
): Promise<boolean> {
  const user = await ensureQuotaWindow(userId);
  if (!user) return false;
  if (user.role === 'ADMIN') return true;

  const normalized = normalizeNonNegativeAmount(bytes);
  if (normalized <= 0) return true;

  // 条件原子扣减：仅当扣减后不超过 limit 才更新。affectedRows=1 表示预留成功。
  const affected = await prisma.$executeRaw`
    UPDATE User
    SET storageBytesUsed = storageBytesUsed + ${BigInt(normalized)}
    WHERE id = ${userId}
      AND storageBytesUsed + ${BigInt(normalized)} <= storageBytesLimit
  `;
  return affected === 1;
}

/**
 * 从 storageBytesUsed 扣减（用于删除 chat 附件释放配额）。低于 0 截断到 0。
 */
export async function releaseStorageBytes(
  userId: string,
  bytes: number
): Promise<UserQuotaSnapshot | null> {
  const user = await ensureQuotaWindow(userId);
  if (!user) return null;
  if (user.role === 'ADMIN') return toQuotaSnapshot(user);

  const normalized = normalizeNonNegativeAmount(bytes);
  if (normalized <= 0) return toQuotaSnapshot(user);

  // 用 raw SQL 保证不会减到负数（Prisma decrement 不带 GREATEST）
  await prisma.$executeRaw`
    UPDATE User
    SET storageBytesUsed = GREATEST(0, storageBytesUsed - ${BigInt(normalized)})
    WHERE id = ${userId}
  `;
  const refreshed = await prisma.user.findUnique({
    where: { id: userId },
    select: QUOTA_USER_SELECT,
  });
  return refreshed ? toQuotaSnapshot(refreshed) : null;
}

/**
 * 原子预留转录分钟（用于异步上传入口的"先占额度"门禁）。
 *
 * 与 deductTranscriptionMinutes 的区别：这是**条件原子**扣减——只有当
 * `transcriptionMinutesUsed + minutes <= transcriptionMinutesLimit` 时才真正写库并返回 true；
 * 否则不写库、返回 false。用一条 `UPDATE ... WHERE` 完成校验+扣减，杜绝"先 checkQuota 再上传"
 * 之间的并发击穿（多个上传同时通过非原子读检查、叠加后超额），也修正"还剩 1 分钟仍放行
 * 300 分钟文件"的投影漏洞（按声明时长投影后再判 limit）。
 *
 * 先 ensureQuotaWindow 做跨月窗口校正，再原子预留——保证预留落在正确的当月窗口。
 * ADMIN 视为无限：直接放行、不写库、返回 true。
 * 调用方在后续步骤失败时应调用 releaseTranscriptionMinutes 回滚预留的额度。
 */
export async function reserveTranscriptionMinutes(
  userId: string,
  minutes: number,
  db: QuotaDbClient = prisma
): Promise<boolean> {
  const user = await ensureQuotaWindow(userId, new Date(), db);
  if (!user) return false;
  if (user.role === 'ADMIN') return true;

  const normalized = normalizeNonNegativeAmount(minutes);
  if (normalized <= 0) return true;

  // 条件原子扣减：仅当扣减后不超过「月度上限 + 购买池」才更新。affectedRows=1 表示预留成功。
  // Model A：used 仍只 +normalized（数学不变），仅门禁放宽到含 gross 池；used 可因此超过 limit，
  // 超出部分即本周期已动用的池子分钟，月度重置时按 owed 从池中结算。
  const affected = await db.$executeRaw`
    UPDATE User
    SET transcriptionMinutesUsed = transcriptionMinutesUsed + ${normalized}
    WHERE id = ${userId}
      AND transcriptionMinutesUsed + ${normalized}
          <= transcriptionMinutesLimit + purchasedMinutesBalance
  `;
  return affected === 1;
}

export interface ShrinkReservationResult {
  /** 实际预扣的分钟（0=额度已耗尽，调用方应拒绝；ADMIN 恒等于请求值、不写库）。 */
  reservedMinutes: number;
  role: string;
}

/**
 * 原子**收缩**预留转录分钟（R1-L2：Soniox 临时 key 签发时的预扣门禁）。
 *
 * 与 reserveTranscriptionMinutes（定额、不够即拒）不同：这里按「剩余额度」收缩——
 * 预扣 min(maxMinutes, limit-used)，返回实际预扣量；剩 0 才拒。这样额度只剩 3 分钟的用户
 * 仍能发起一条最长 3 分钟的流（key 的 max_session_duration_seconds 会同步收缩到预扣量，
 * 到点 Soniox 硬断），月度额度第一次成为实时强制，而非事后超扣。
 *
 * MySQL 无 UPDATE...RETURNING，「读剩余→算收缩值→写」必须 FOR UPDATE 锁行才原子（同
 * settleReservation 的模式）：要求调用方传入**事务客户端**。先 ensureQuotaWindow（事务内）
 * 做跨月窗口校正，再锁行读、条件写。ADMIN 无限额：不写库、按请求值放行。
 */
export async function reserveTranscriptionMinutesUpTo(
  userId: string,
  maxMinutes: number,
  tx: QuotaDbClient
): Promise<ShrinkReservationResult | null> {
  const user = await ensureQuotaWindow(userId, new Date(), tx);
  if (!user) return null;
  if (user.role === 'ADMIN') {
    return { reservedMinutes: Math.max(1, Math.floor(maxMinutes)), role: user.role };
  }

  const requested = Math.max(0, Math.floor(maxMinutes));
  if (requested <= 0) {
    return { reservedMinutes: 0, role: user.role };
  }

  const rows = await tx.$queryRaw<
    Array<{
      transcriptionMinutesUsed: number;
      transcriptionMinutesLimit: number;
      purchasedMinutesBalance: number;
    }>
  >`
    SELECT transcriptionMinutesUsed, transcriptionMinutesLimit, purchasedMinutesBalance
    FROM User WHERE id = ${userId} FOR UPDATE
  `;
  const row = rows[0];
  if (!row) return null;

  // Model A：可预扣 = max(0, (月度上限 + 购买池) − 已用)。含池子后，免费额度耗尽的用户仍能凭
  // 购买时长发起流（key 的 max_session_duration_seconds 随之收缩到此值，而非在免费额度耗尽即硬断）。
  const remaining = Math.max(
    0,
    Number(row.transcriptionMinutesLimit) +
      Number(row.purchasedMinutesBalance) -
      Number(row.transcriptionMinutesUsed)
  );
  const granted = Math.min(requested, remaining);
  if (granted <= 0) {
    return { reservedMinutes: 0, role: user.role };
  }

  await tx.$executeRaw`
    UPDATE User
    SET transcriptionMinutesUsed = transcriptionMinutesUsed + ${granted}
    WHERE id = ${userId}
  `;
  return { reservedMinutes: granted, role: user.role };
}

/**
 * 回滚 reserveTranscriptionMinutes 预留的分钟（低于 0 截断到 0）。
 * 用 raw SQL + GREATEST 保证不会减到负数（Prisma decrement 不带 GREATEST）。
 */
export async function releaseTranscriptionMinutes(
  userId: string,
  minutes: number,
  db: QuotaDbClient = prisma
): Promise<void> {
  const normalized = normalizeNonNegativeAmount(minutes);
  if (normalized <= 0) return;

  await db.$executeRaw`
    UPDATE User
    SET transcriptionMinutesUsed = GREATEST(0, transcriptionMinutesUsed - ${normalized})
    WHERE id = ${userId}
  `;
}

/**
 * 在途预留列的白名单——只有这两列是「计入 transcriptionMinutesUsed 的原子预留」。settleReservation
 * 用它做 raw SQL 标识符的硬门禁，杜绝任何非预期列名拼进 SQL（列名恒来自本模块内部字面量、非外部输入，
 * 白名单是纵深防御）。
 */
const RESERVATION_COLUMNS = ['asyncReservedMinutes', 'fullReservedMinutes'] as const;
export type ReservationColumn = (typeof RESERVATION_COLUMNS)[number];

/**
 * 原子结算一笔在途预留（B1/R4 的统一释放原语）。async 与 full 两类预留共用，仅列名不同。
 *
 * FOR UPDATE 锁住 Session 行 → 读当前 `column` 列 + userId → 若 >0 则清零该列并
 * releaseTranscriptionMinutes(该额)。**恰好一次**：并发的多条释放路径（finalize 结算 / 删会话 /
 * re-init 顶替 / cron 兜底）都经此原语时，只有第一个读到 >0 的能清零并释放，其余在行锁后读到 0 →
 * 直接返回 0、不重复释放。杜绝审查发现的一切「按请求开头快照无条件裸减」造成的双释放/额度白送。
 *
 * 读的是**行上的当前值**（非调用方快照）：deduct 内部 ensureQuotaWindow 可能刚触发月度重置并顺带
 * 清了本列，此时当前值=0 → 不再释放，避免跨周期把已被重置隐式清除的预留再减一次。
 *
 * @param column 要结算的预留列（白名单内）。SELECT 不加别名、按 row[column] 取值，保持与列名一致。
 * @param db 可选事务客户端。finalize 结算传入其 $transaction 的 tx，使「deduct 实扣 ⟺ 释放预留」
 *   在同一事务内一致提交。默认自开事务以保证 FOR UPDATE 行锁生效。
 * @returns 实际释放的分钟（0 表示该预留已被别的路径结算或本就为 0）。
 */
export async function settleReservation(
  sessionId: string,
  column: ReservationColumn,
  db: QuotaDbClient = prisma
): Promise<number> {
  if (!RESERVATION_COLUMNS.includes(column)) {
    // 白名单硬门禁：非预期列名一律拒绝，绝不拼进 raw SQL。
    throw new Error(`settleReservation: unsupported reservation column ${column}`);
  }

  const run = async (tx: QuotaDbClient): Promise<number> => {
    // SELECT 不加别名：返回行以真实列名为键（row[column]），既能读到值、又让本原语对两列同构。
    // column 已过白名单校验，Prisma.raw 拼入的仅是受控标识符，无注入面。
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(
      Prisma.sql`SELECT userId, ${Prisma.raw(column)} FROM Session WHERE id = ${sessionId} FOR UPDATE`
    );
    const row = rows[0];
    if (!row) {
      return 0;
    }
    const minutes = Number(row[column] ?? 0);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return 0;
    }
    const userId = String(row.userId);
    await tx.session.update({
      where: { id: sessionId },
      // 计算键：column ∈ 白名单两列，both Int，赋 0 类型相容（TS 无法从字面量联合推断计算键，故 cast）。
      data: { [column]: 0 } as Prisma.SessionUpdateInput,
    });
    await releaseTranscriptionMinutes(userId, minutes, tx);
    return minutes;
  };

  // 已在外层事务里（db 是 tx，无 $transaction 方法）→ 直接跑；否则自开事务保证 FOR UPDATE 生效。
  const maybeClient = db as unknown as { $transaction?: typeof prisma.$transaction };
  if (typeof maybeClient.$transaction === 'function') {
    return maybeClient.$transaction(run);
  }
  return run(db);
}

/**
 * 结算异步上传预留（B1）。settleReservation 的具名封装，保持所有既有调用/测试口径不变。
 * 见 settleReservation。
 */
export async function settleAsyncReservation(
  sessionId: string,
  db: QuotaDbClient = prisma
): Promise<number> {
  return settleReservation(sessionId, 'asyncReservedMinutes', db);
}

/**
 * 结算完整版补全转录预留（R4）。settleReservation 的具名封装。见 settleReservation。
 */
export async function settleFullReservation(
  sessionId: string,
  db: QuotaDbClient = prisma
): Promise<number> {
  return settleReservation(sessionId, 'fullReservedMinutes', db);
}
