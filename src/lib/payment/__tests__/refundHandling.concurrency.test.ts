import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M6：freezeEntitlements 的会员分支是**读-改-写绝对值**（roleExpiresAt = 读到的到期日 − 本单天数）。
 * 快照读（普通 findUnique）在并发退款下必然 lost update：两笔退款各自基于同一份快照算出同一个
 * 目标日期再写回，后写覆盖先写 → 只缩回一期，另一笔已经退掉的会员期被白留（平台资损）。
 * 同仓 wallet.ts applyGrantTx 对同一张表早就用了 `SELECT … FOR UPDATE`（P3-6）并写明理由，
 * 退款路径漏了同款防护。
 *
 * ── 关于这个事务替身能表达什么、不能表达什么（务必先读） ─────────────────────────────
 * 上一版 refundHandling.test.ts 的替身是 `$transaction: (cb) => cb(tx)` —— 它**结构上无法**
 * 表达并发、快照与提交顺序，用它写「并发 lost update」只会得到一个恒绿的假测试。
 * 本文件另建一个按 InnoDB REPEATABLE READ 语义建模的替身：
 *   ① 一致性读（普通 findUnique）：读**本事务第一次一致性读时**冻结的整库快照，叠加本事务自己
 *      的写（own writes 对自己可见）；
 *   ② 锁读（`$queryRaw … FOR UPDATE`）：先按行排队拿锁（锁持有到事务结束），拿到后读**当前**
 *      已提交值，绕过快照；
 *   ③ 写：直接落到 live store，锁在事务结束时才释放 → 对其他事务而言等价于「提交后可见」。
 * 两个事务用 Promise.all 真并发跑，并在「首次读用户行」处设一道双方都必须到达的栅栏，
 * 保证快照都在任何一方拿锁之前建立 —— 这正是生产上两笔网关回调同时到达的形态。
 *
 * 替身**不**建模的东西（下结论时别越界）：真实的 MVCC 版本链、gap lock、死锁检测与回滚、
 * 语句级 vs 事务级快照的细节，以及「回调跑完 ≠ 已提交」——本替身里事务体跑完即提交。
 * 它能证明的只有一件事：freezeEntitlements 读用户行时**取不取行锁**，决定了两笔并发退款
 * 是各缩一期还是只缩一期。这恰好就是 M6。
 */

interface UserRow {
  walletBalanceCents: number;
  purchasedMinutesBalance: number;
  role: string;
  originalRole: string | null;
  roleExpiresAt: Date | null;
  tokenVersion: number;
}

interface OrderRow {
  id: string;
  userId: string;
  provider: string;
  status: string;
  refundedAt: Date | null;
  amountCents: number;
  metadataJson: string;
}

const store = vi.hoisted(() => ({
  users: new Map<string, UserRow>(),
  orders: new Map<string, OrderRow>(),
  ledger: [] as Array<Record<string, unknown>>,
  /** 每个用户行一条锁队列；持锁到事务结束。 */
  lockTail: new Map<string, Promise<void>>(),
  /** 双事务栅栏：两边都到齐才放行（保证快照都先于任何一方拿锁建立）。 */
  barrier: null as null | { need: number; arrived: number; release: () => void; gate: Promise<void> },
}));

const cloneUsers = () =>
  new Map(
    [...store.users.entries()].map(([k, v]) => [k, { ...v, roleExpiresAt: v.roleExpiresAt }])
  );

function makeBarrier(need: number) {
  let release!: () => void;
  const gate = new Promise<void>((res) => {
    release = res;
  });
  store.barrier = { need, arrived: 0, release, gate };
}

async function hitBarrier() {
  const b = store.barrier;
  if (!b) return;
  b.arrived += 1;
  if (b.arrived >= b.need) b.release();
  await b.gate;
}

/** 行锁：按 userId 排队，返回释放函数（调用方在事务结束时调用）。 */
async function acquireRowLock(userId: string): Promise<() => void> {
  const prev = store.lockTail.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((res) => {
    release = res;
  });
  store.lockTail.set(userId, prev.then(() => mine));
  await prev;
  return release;
}

interface TxCtx {
  snapshot: Map<string, UserRow> | null;
  ownWrites: Map<string, UserRow>;
  releases: Array<() => void>;
  firstUserRead: boolean;
}

vi.mock('@/lib/prisma', () => {
  function makeTxClient(ctx: TxCtx) {
    /** 一致性读：首次读时冻结快照（InnoDB：事务内第一次一致性读建立 read view）。 */
    const consistentRead = (userId: string): UserRow | null => {
      if (!ctx.snapshot) ctx.snapshot = cloneUsers();
      return ctx.ownWrites.get(userId) ?? ctx.snapshot.get(userId) ?? null;
    };
    const writeUser = (userId: string, next: UserRow) => {
      store.users.set(userId, next);
      ctx.ownWrites.set(userId, { ...next });
    };
    return {
      paymentOrder: {
        findUnique: async ({ where }: { where: { outTradeNo: string } }) => {
          if (!ctx.snapshot) ctx.snapshot = cloneUsers(); // 同样是一次一致性读
          return store.orders.get(where.outTradeNo) ?? null;
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: { outTradeNo: string; status: string; refundedAt: null; provider: string };
          data: Record<string, unknown>;
        }) => {
          const row = store.orders.get(where.outTradeNo);
          if (
            !row ||
            row.status !== where.status ||
            row.refundedAt !== null ||
            row.provider !== where.provider
          ) {
            return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
        },
      },
      user: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          if (!ctx.firstUserRead) {
            ctx.firstUserRead = true;
            await hitBarrier();
          }
          return consistentRead(where.id);
        },
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const cur = store.users.get(where.id);
          if (!cur) throw new Error('user not found');
          const next: UserRow = { ...cur };
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object' && 'increment' in (v as object)) {
              (next as unknown as Record<string, number>)[k] =
                ((cur as unknown as Record<string, number>)[k] ?? 0) +
                (v as { increment: number }).increment;
            } else {
              (next as unknown as Record<string, unknown>)[k] = v;
            }
          }
          writeUser(where.id, next);
          return next;
        },
      },
      walletTransaction: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          store.ledger.push(data);
          return data;
        },
      },
      /** 锁读：`SELECT … FOR UPDATE`。排队拿行锁 → 读**当前**值（不走快照）。 */
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
        if (!/FOR UPDATE/i.test(sql)) throw new Error(`未预期的 $queryRaw: ${sql}`);
        const userId = String(values[0]);
        if (!ctx.firstUserRead) {
          ctx.firstUserRead = true;
          await hitBarrier();
        }
        ctx.releases.push(await acquireRowLock(userId));
        const cur = store.users.get(userId);
        return cur ? [{ ...cur }] : [];
      },
      /** 相对更新（GREATEST 地板）——直接落 live store，与快照无关。 */
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
        const amount = Number(values[0]);
        const userId = String(values[1]);
        const cur = store.users.get(userId);
        if (!cur) return 0;
        const col = /walletBalanceCents/.test(sql)
          ? 'walletBalanceCents'
          : 'purchasedMinutesBalance';
        const next: UserRow = {
          ...cur,
          [col]: Math.max(0, (cur as unknown as Record<string, number>)[col] - amount),
        } as UserRow;
        writeUser(userId, next);
        return 1;
      },
    };
  }

  const runTx = async (cb: (tx: unknown) => Promise<unknown>) => {
    const ctx: TxCtx = {
      snapshot: null,
      ownWrites: new Map(),
      releases: [],
      firstUserRead: false,
    };
    try {
      return await cb(makeTxClient(ctx));
    } finally {
      // 提交（或回滚）：释放本事务持有的全部行锁 → 排队者此刻才看得见我们的写。
      for (const release of ctx.releases) release();
    }
  };

  return { prisma: { $transaction: runTx } };
});

vi.mock('@/lib/auditLog', () => ({ logSystemEvent: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import { handlePaymentReversal } from '@/lib/payment/refundHandling';

const DAY = 86_400_000;
const membershipMeta = (tierName: string) =>
  JSON.stringify({
    creditCents: 3900,
    grant: { kind: 'membership', durationDays: 30, tierId: 't1', tierName },
  });

beforeEach(() => {
  store.users.clear();
  store.orders.clear();
  store.ledger.length = 0;
  store.lockTail.clear();
  store.barrier = null;
});

describe('handlePaymentReversal — M6：并发退款不得 lost update', () => {
  it('▶ 同一用户两笔会员单同时退款 → 到期日各缩一期（共 60 天），不是只缩 30 天', async () => {
    const base = new Date('2026-08-22T00:00:00.000Z');
    store.users.set('u1', {
      walletBalanceCents: 0,
      purchasedMinutesBalance: 0,
      role: 'PRO',
      originalRole: 'FREE',
      roleExpiresAt: new Date(base.getTime() + 90 * DAY),
      tokenVersion: 1,
    });
    for (const no of ['LL-A', 'LL-B']) {
      store.orders.set(no, {
        id: `o-${no}`,
        userId: 'u1',
        provider: 'stripe',
        status: 'paid',
        refundedAt: null,
        amountCents: 3900,
        metadataJson: membershipMeta(`PRO 月卡 ${no}`),
      });
    }
    // 两笔回调同时到达：都必须先建立各自快照，再去争用户行锁。
    makeBarrier(2);

    const results = await Promise.all([
      handlePaymentReversal({ outTradeNo: 'LL-A', provider: 'stripe' }),
      handlePaymentReversal({ outTradeNo: 'LL-B', provider: 'stripe' }),
    ]);

    // 两笔都各自认领成功（CAS 在不同订单行上，互不相干）。
    expect(results.map((r) => r.outcome)).toEqual(['reversed', 'reversed']);
    expect(store.ledger.filter((l) => l.type === 'refund')).toHaveLength(2);

    const after = store.users.get('u1')!;
    const shrunkDays = Math.round(
      (base.getTime() + 90 * DAY - after.roleExpiresAt!.getTime()) / DAY
    );
    // ▶ 快照读版本这里是 30：两笔都从「+90 天」算出「+60 天」再写回，后写覆盖先写，
    //   一笔已退款的会员期被白留（平台资损）。
    expect(shrunkDays).toBe(60);
  });

  it('▶ 退款与「刚买的 30 天」并发：购买先提交，退款必须在其之上缩期，不得抹掉这次购买', async () => {
    const base = new Date('2026-08-22T00:00:00.000Z');
    store.users.set('u1', {
      walletBalanceCents: 0,
      purchasedMinutesBalance: 0,
      role: 'PRO',
      originalRole: 'FREE',
      roleExpiresAt: new Date(base.getTime() + 10 * DAY),
      tokenVersion: 1,
    });
    store.orders.set('LL-R', {
      id: 'o-R',
      userId: 'u1',
      provider: 'stripe',
      status: 'paid',
      refundedAt: null,
      amountCents: 3900,
      metadataJson: membershipMeta('PRO 月卡'),
    });

    // 并发的余额购买：同样按 applyGrantTx 的口径先 FOR UPDATE 锁读再叠加续期。
    const { prisma } = (await import('@/lib/prisma')) as unknown as {
      prisma: { $transaction: (cb: (tx: never) => Promise<unknown>) => Promise<unknown> };
    };
    const purchase = () =>
      prisma.$transaction(async (tx: never) => {
        const t = tx as unknown as {
          user: {
            findUnique: (a: unknown) => Promise<UserRow | null>;
            update: (a: unknown) => Promise<UserRow>;
          };
          $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<UserRow[]>;
        };
        const rows = await t.$queryRaw(
          Object.assign(['SELECT roleExpiresAt FROM User WHERE id = ', ' FOR UPDATE'], {
            raw: [],
          }) as unknown as TemplateStringsArray,
          'u1'
        );
        const cur = rows[0];
        const from =
          cur.roleExpiresAt && cur.roleExpiresAt > base ? cur.roleExpiresAt : base;
        await t.user.update({
          where: { id: 'u1' },
          data: { roleExpiresAt: new Date(from.getTime() + 30 * DAY) },
        });
        return null;
      });

    makeBarrier(2);
    await Promise.all([
      purchase(),
      handlePaymentReversal({ outTradeNo: 'LL-R', provider: 'stripe' }),
    ]);

    const after = store.users.get('u1')!;
    const finalDays = Math.round((after.roleExpiresAt!.getTime() - base.getTime()) / DAY);
    // 起点 +10 天，买 30 天 → +40；退 30 天 → +10。两笔各自看见对方的提交结果。
    // ▶ 快照读版本：退款读到「+10 天」的旧快照 → 算出 −20 天 ≤ now → 直接把用户降级、
    //   roleExpiresAt 清空，刚买的 30 天连同 originalRole 一起被抹掉（用户资损）。
    expect(after.roleExpiresAt).not.toBeNull();
    expect(after.role).toBe('PRO');
    expect(finalDays).toBe(10);
  });
});
