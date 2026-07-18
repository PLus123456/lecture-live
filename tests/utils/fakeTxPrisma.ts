import { vi } from 'vitest';

/**
 * 极小的 Prisma 事务替身：只回答一个问题——「这次写入最终提交了没有」。
 *
 * 关键在于**按客户端而不是按时间**区分事务内外，这正是它能抓住「先烧后用」的原因：
 * 真实 Prisma 里 `prisma.x.update()` 即使写在 `$transaction(async (tx) => ...)` 回调里，
 * 走的也是另一条连接、立刻独立提交，回滚不了它。所以这里顶层 client 的写入一律直接
 * 计入 `committed`，只有经 `tx` 客户端的写入才进 `pending`，回调 resolve 才并入
 * `committed`、抛错则整批丢弃。
 *
 * 于是「认领令牌忘了传 db（或写在事务外）」会在断言里如实表现为：
 * 改密失败了，令牌的 consumedAt 却已提交。
 */
export type FakeWrite = { op: string; args: unknown };

type Delegates = Record<string, Record<string, (args: never) => unknown>>;

export function createFakeTxPrisma(delegates: Delegates) {
  const committed: FakeWrite[] = [];
  let pending: FakeWrite[] | null = null;

  const isWrite = (method: string) => /^(create|update|delete|upsert)/i.test(method);

  /** inTx=false → 立即提交（模拟独立连接）；inTx=true → 记进当前事务批次。 */
  const buildStubs = (inTx: boolean) => {
    const client: Record<string, Record<string, unknown>> = {};
    for (const [model, methods] of Object.entries(delegates)) {
      const stub: Record<string, unknown> = {};
      for (const [method, impl] of Object.entries(methods)) {
        stub[method] = vi.fn(async (args: unknown) => {
          if (isWrite(method)) {
            const write = { op: `${model}.${method}`, args };
            if (inTx && pending) pending.push(write);
            else committed.push(write);
          }
          return (impl as (a: unknown) => unknown)(args);
        });
      }
      client[model] = stub;
    }
    return client;
  };

  const topLevel = buildStubs(false);
  const txClient = buildStubs(true);

  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const outer = pending;
    const batch: FakeWrite[] = [];
    pending = batch;
    try {
      const result = await fn(txClient);
      // 提交：本批写入并入外层批次（嵌套）或已提交集
      (outer ?? committed).push(...batch);
      return result;
    } finally {
      pending = outer;
    }
  });

  return {
    client: { ...topLevel, $transaction } as Record<string, unknown>,
    $transaction,
    /** 已提交的写入（随事务回滚掉的不在此列）。 */
    committed,
    committedOps: () => committed.map((w) => w.op),
    reset: () => {
      committed.length = 0;
      pending = null;
    },
  };
}
