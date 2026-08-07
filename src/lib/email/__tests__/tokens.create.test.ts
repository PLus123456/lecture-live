import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C57/P6-12：createEmailToken 的「作废旧令牌 + 建新令牌」必须同事务。
 *
 * 两条语句各自自动提交时，并发签发会交错成 作废A → 作废B → 建A → 建B，
 * 于是两条重置链接同时有效——「同用户同类型一次只留一枚」的口径破功。
 * forgot-password 路由是刻意不 await 的 `void createEmailToken(...)`，竞态很好命中。
 *
 * 这里的假 prisma **会真的交错**：每条语句先让出一个微任务再落库，
 * 而 `$transaction` 持一把互斥锁把回调整体串行化（对应真库里的行锁）。
 * 所以「用了 $transaction」与「没用」在这个替身上结果不同，不是自证的假测试。
 */

const { state, prismaMock } = vi.hoisted(() => {
  interface HoistedRow {
    id: string;
    userId: string;
    type: string;
    tokenHash: string;
    consumedAt: Date | null;
  }

  const inner = {
    rows: [] as HoistedRow[],
    seq: 0,
    txDepth: 0,
    /** 每条 emailToken 写语句执行时的事务深度，用来断言"写在事务里发生" */
    writeDepths: [] as number[],
    txLock: Promise.resolve(),
  };

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  // 显式命名类型：$transaction 的回调参数是 client 自身，写成 `typeof client` 会让
  // client 的类型推断引用自己（TS7022 隐式 any 循环）。
  type MockClient = {
    emailToken: {
      updateMany(args: {
        where: Record<string, unknown>;
        data: { consumedAt: Date };
      }): Promise<{ count: number }>;
      create(args: {
        data: Omit<HoistedRow, 'id' | 'consumedAt'>;
      }): Promise<HoistedRow>;
    };
    $transaction<T>(cb: (tx: MockClient) => Promise<T>): Promise<T>;
  };

  const client: MockClient = {
    emailToken: {
      async updateMany({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: { consumedAt: Date };
      }) {
        await tick();
        inner.writeDepths.push(inner.txDepth);
        let count = 0;
        for (const row of inner.rows) {
          if (
            row.userId === where.userId &&
            row.type === where.type &&
            row.consumedAt === null
          ) {
            row.consumedAt = data.consumedAt;
            count += 1;
          }
        }
        return { count };
      },
      async create({ data }: { data: Omit<HoistedRow, 'id' | 'consumedAt'> }) {
        await tick();
        inner.writeDepths.push(inner.txDepth);
        inner.seq += 1;
        const row: HoistedRow = { id: `t${inner.seq}`, consumedAt: null, ...data };
        inner.rows.push(row);
        return row;
      },
    },
    async $transaction<T>(cb: (tx: MockClient) => Promise<T>): Promise<T> {
      // 互斥：同一时刻只跑一个事务回调（模拟真库对同一 (userId,type) 集合的行锁串行化）
      const previous = inner.txLock;
      let release!: () => void;
      inner.txLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      inner.txDepth += 1;
      try {
        return await cb(client);
      } finally {
        inner.txDepth -= 1;
        release();
      }
    },
  };

  return { state: inner, prismaMock: client };
});

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { createEmailToken } from '@/lib/email/tokens';

describe('createEmailToken 的原子性 (C57 / P6-12)', () => {
  beforeEach(() => {
    state.rows = [];
    state.seq = 0;
    state.txDepth = 0;
    state.writeDepths = [];
    state.txLock = Promise.resolve();
  });

  it('并发签发两枚重置令牌后，只剩一枚未消费', async () => {
    await Promise.all([
      createEmailToken({ userId: 'u1', type: 'RESET_PASSWORD' }),
      createEmailToken({ userId: 'u1', type: 'RESET_PASSWORD' }),
    ]);

    expect(state.rows).toHaveLength(2);
    const live = state.rows.filter((row) => row.consumedAt === null);
    expect(live).toHaveLength(1);
  });

  it('两条写语句都发生在事务内', async () => {
    await createEmailToken({ userId: 'u1', type: 'VERIFY_EMAIL' });
    expect(state.writeDepths).toEqual([1, 1]);
  });

  it('串行签发时旧令牌仍被作废（原有语义不变）', async () => {
    const first = await createEmailToken({ userId: 'u1', type: 'RESET_PASSWORD' });
    const second = await createEmailToken({ userId: 'u1', type: 'RESET_PASSWORD' });

    expect(first.rawToken).not.toBe(second.rawToken);
    expect(state.rows.filter((row) => row.consumedAt === null)).toHaveLength(1);
  });

  it('不同用户 / 不同类型互不影响', async () => {
    await Promise.all([
      createEmailToken({ userId: 'u1', type: 'RESET_PASSWORD' }),
      createEmailToken({ userId: 'u2', type: 'RESET_PASSWORD' }),
      createEmailToken({ userId: 'u1', type: 'VERIFY_EMAIL' }),
    ]);

    expect(state.rows.filter((row) => row.consumedAt === null)).toHaveLength(3);
  });
});
