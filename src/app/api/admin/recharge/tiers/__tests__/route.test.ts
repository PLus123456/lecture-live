import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  tierCreateMock,
  tierUpdateMock,
  tierDeleteMock,
  tierFindUniqueMock,
  tierFindManyMock,
  logActionMock,
  writeSecurityAuditMock,
  transactionMock,
  txClient,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  tierCreateMock: vi.fn(),
  tierUpdateMock: vi.fn(),
  tierDeleteMock: vi.fn(),
  tierFindUniqueMock: vi.fn(),
  tierFindManyMock: vi.fn(),
  logActionMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  transactionMock: vi.fn(),
  txClient: {
    rechargeTier: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/auditLog', () => ({
  logAction: logActionMock,
}));

vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
}));

vi.mock('@/lib/requestLogger', () => ({
  withRequestLogging:
    (_scope: string, handler: (req: Request) => Promise<Response>) => handler,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: transactionMock,
    rechargeTier: {
      create: tierCreateMock,
      update: tierUpdateMock,
      delete: tierDeleteMock,
      findUnique: tierFindUniqueMock,
      findMany: tierFindManyMock,
    },
  },
}));

import { DELETE, GET, PATCH, POST } from '@/app/api/admin/recharge/tiers/route';

/** withRequestLogging 包出来的 handler 形参是 (req, context)；路由本身不读 context。 */
const CTX = { params: Promise.resolve({}) } as never;

/** 一个「已停用、卖 FREE、排序 9」的会员档：这四个字段正是 PATCH 会静默重置的那四个。 */
const EXISTING = {
  id: 't1',
  kind: 'membership',
  name: '老档位',
  priceCents: 3900,
  grantRole: 'FREE',
  durationDays: 365,
  grantMinutes: null,
  creditCents: null,
  active: false,
  sortOrder: 9,
};

beforeEach(() => {
  requireAdminAccessMock.mockReset();
  tierCreateMock.mockReset();
  tierUpdateMock.mockReset();
  tierDeleteMock.mockReset();
  tierFindUniqueMock.mockReset();
  tierFindManyMock.mockReset();
  logActionMock.mockReset();
  writeSecurityAuditMock.mockReset();
  transactionMock.mockReset();
  requireAdminAccessMock.mockResolvedValue({
    user: { id: 'admin-1', email: 'a@b.c', role: 'ADMIN' },
    response: null,
  });
  tierCreateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'new',
    ...data,
  }));
  tierUpdateMock.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ ...EXISTING, ...data })
  );
  tierDeleteMock.mockResolvedValue(EXISTING);
  tierFindUniqueMock.mockResolvedValue(EXISTING);
  tierFindManyMock.mockResolvedValue([EXISTING]);
  writeSecurityAuditMock.mockResolvedValue({ requestId: 'req-1', action: 'audit' });
  Object.assign(txClient.rechargeTier, {
    create: tierCreateMock,
    update: tierUpdateMock,
    delete: tierDeleteMock,
    findUnique: tierFindUniqueMock,
    findMany: tierFindManyMock,
  });
  transactionMock.mockImplementation(
    async (callback: (tx: typeof txClient) => Promise<unknown>) => callback(txClient)
  );
});

const post = (body: unknown) =>
  POST(createJsonRequest('http://localhost/api/admin/recharge/tiers', { method: 'POST', body }), CTX);
const patch = (body: unknown) =>
  PATCH(createJsonRequest('http://localhost/api/admin/recharge/tiers', { method: 'PATCH', body }), CTX);
const get = () => GET(new Request('http://localhost/api/admin/recharge/tiers'), CTX);
const remove = (id = 't1') =>
  DELETE(new Request(`http://localhost/api/admin/recharge/tiers?id=${id}`, { method: 'DELETE' }), CTX);

describe('SEC-033：档位读取与强制安全审计', () => {
  it('GET 正常返回前等待 SUCCESS 审计', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tiers: [{ id: 't1' }] });
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'recharge.tiers.read',
        operator: { id: 'admin-1', email: 'a@b.c', role: 'ADMIN' },
        target: { type: 'recharge_tier_collection' },
        reason: 'admin_list',
        outcome: 'SUCCESS',
        metadata: { count: 1 },
      })
    );
  });

  it('GET 审计失败时 503，且不泄露已组装档位 payload', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await get();
    const body = await res.text();

    expect(res.status).toBe(503);
    expect(body).not.toContain('老档位');
    expect(body).not.toContain('t1');
  });
});

describe('SEC-033：档位 mutation 与 SUCCESS 审计同事务', () => {
  it('POST 审计 reject 会拒绝事务、返回 503，且不写 legacy 成功日志', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    const commits: string[] = [];
    transactionMock.mockImplementationOnce(
      async (callback: (tx: typeof txClient) => Promise<unknown>) => {
        const result = await callback(txClient);
        commits.push('committed');
        return result;
      }
    );
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await post({ kind: 'topup', name: '充值', priceCents: 1000 });

    expect(res.status).toBe(503);
    expect(commits).toEqual([]);
    expect(logActionMock).not.toHaveBeenCalled();
    expect(writeSecurityAuditMock.mock.calls[0][2]).toBe(txClient);
  });

  it('PATCH 在事务内记录实际 before/after', async () => {
    const res = await patch({ id: 't1', name: '新名字', grantRole: 'PRO' });

    expect(res.status).toBe(200);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'recharge.tier.update',
        target: { type: 'recharge_tier', id: 't1' },
        before: expect.objectContaining({ id: 't1', name: '老档位', grantRole: 'FREE' }),
        after: expect.objectContaining({ id: 't1', name: '新名字', grantRole: 'PRO' }),
        reason: 'admin_update',
        outcome: 'SUCCESS',
      }),
      txClient
    );
  });

  it('DELETE 在事务内记录被删除档位的安全快照', async () => {
    const res = await remove();

    expect(res.status).toBe(200);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'recharge.tier.delete',
        target: { type: 'recharge_tier', id: 't1' },
        before: expect.objectContaining({ id: 't1', grantRole: 'FREE' }),
        reason: 'admin_delete',
        outcome: 'SUCCESS',
      }),
      txClient
    );
  });
});

describe('档位创建：价格闸', () => {
  // P3-7：¥0 的会员/时长档 = 无限提款机（applyGrantTx 的余额守卫对 0 恒真）。
  // 「建个 0 元体验档做促销」是很自然的管理动作，建完即提款机。
  it('▶ P3-7 会员档 priceCents=0 → 400', async () => {
    const res = await post({ kind: 'membership', name: '体验', priceCents: 0, durationDays: 7 });
    expect(res.status).toBe(400);
    expect(tierCreateMock).not.toHaveBeenCalled();
  });

  it('▶ P3-7 时长档 priceCents=0 → 400', async () => {
    const res = await post({ kind: 'minutes', name: '体验', priceCents: 0, grantMinutes: 60 });
    expect(res.status).toBe(400);
    expect(tierCreateMock).not.toHaveBeenCalled();
  });

  it('▶ topup 档 priceCents=0 不受限（充 0 送 0 无害，且是历史行为）', async () => {
    const res = await post({ kind: 'topup', name: '零元', priceCents: 0 });
    expect(res.status).toBe(200);
  });

  // P3-13：`Number(null) === 0` 把「没填到账额」变成「到账 0 元」——用户付全价、钱包一分不进。
  it('▶ P3-13 topup 档不填 creditCents → 回落成等于价格（不是 0）', async () => {
    await post({ kind: 'topup', name: '充100', priceCents: 10000, creditCents: null });
    expect(tierCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ creditCents: 10000 }) })
    );
  });

  it('▶ P3-13 显式填 0 仍然尊重（管理员真想建赠 0 的档位是他的自由）', async () => {
    await post({ kind: 'topup', name: '充100', priceCents: 10000, creditCents: 0 });
    expect(tierCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ creditCents: 0 }) })
    );
  });
});

describe('档位 PATCH：局部更新', () => {
  // P3-9：PATCH 从前复用「缺省即默认值」的整套归一化逻辑——只改个名字，就把停用的档位改回
  // 上架、把卖 FREE 的档位改成卖 PRO、把排序清零。
  it('▶ P3-9 只改名字 → 不碰 active / sortOrder / grantRole', async () => {
    const res = await patch({ id: 't1', name: '新名字' });
    expect(res.status).toBe(200);
    const data = tierUpdateMock.mock.calls[0][0].data;
    expect(data).toEqual({ name: '新名字' });
    expect(data.active).toBeUndefined();
    expect(data.sortOrder).toBeUndefined();
    expect(data.grantRole).toBeUndefined();
  });

  it('▶ P3-9 显式传的字段照常写入', async () => {
    await patch({ id: 't1', active: true, sortOrder: 3 });
    expect(tierUpdateMock.mock.calls[0][0].data).toEqual({ active: true, sortOrder: 3 });
  });

  it('▶ P3-9 换 kind 时派生列跟着重算（不残留旧 kind 的值）', async () => {
    await patch({ id: 't1', kind: 'minutes', grantMinutes: 600 });
    const data = tierUpdateMock.mock.calls[0][0].data;
    expect(data.kind).toBe('minutes');
    expect(data.grantMinutes).toBe(600);
    // 旧 kind 的会员列必须被清掉，否则一个 minutes 档还挂着 grantRole=FREE / durationDays=365。
    expect(data.grantRole).toBeNull();
    expect(data.durationDays).toBeNull();
  });

  it('▶ P3-9 缺省字段以现有行参与校验（改名不因「没传天数」而 400）', async () => {
    const res = await patch({ id: 't1', name: 'x' });
    expect(res.status).toBe(200);
  });

  it('▶ 档位不存在 → 404', async () => {
    tierFindUniqueMock.mockResolvedValueOnce(null);
    const res = await patch({ id: 'nope', name: 'x' });
    expect(res.status).toBe(404);
  });

  it('▶ P3-7 PATCH 显式把会员档改成 ¥0 → 400', async () => {
    const res = await patch({ id: 't1', priceCents: 0 });
    expect(res.status).toBe(400);
    expect(tierUpdateMock).not.toHaveBeenCalled();
  });

  // 历史遗留的 0 元档必须还能停用——否则修 bug 反而把补救手段一起锁死。
  it('▶ P3-7 不改价格时不追究历史 ¥0 档（仍可停用）', async () => {
    tierFindUniqueMock.mockResolvedValueOnce({ ...EXISTING, priceCents: 0 });
    const res = await patch({ id: 't1', active: false });
    expect(res.status).toBe(200);
  });
});

describe('SEC-023：会员商品不能授予 ADMIN', () => {
  it('▶ 创建 ADMIN 会员档 → 400，且不落库', async () => {
    const res = await post({
      kind: 'membership',
      name: '超级档',
      priceCents: 100,
      grantRole: 'ADMIN',
      durationDays: 3650,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('管理员') });
    expect(tierCreateMock).not.toHaveBeenCalled();
  });

  it('▶ 把普通会员档改成 ADMIN → 400，且不更新', async () => {
    const res = await patch({ id: 't1', grantRole: 'ADMIN' });

    expect(res.status).toBe(400);
    expect(tierUpdateMock).not.toHaveBeenCalled();
  });

  it('▶ 历史 ADMIN 商品仍可停用，停用时不重写 grantRole', async () => {
    tierFindUniqueMock.mockResolvedValueOnce({
      ...EXISTING,
      grantRole: 'ADMIN',
      active: true,
    });

    const res = await patch({ id: 't1', active: false });

    expect(res.status).toBe(200);
    expect(tierUpdateMock).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { active: false },
    });
  });

  it('▶ 已停用的历史 ADMIN 商品不能重新上架', async () => {
    tierFindUniqueMock.mockResolvedValueOnce({
      ...EXISTING,
      grantRole: 'ADMIN',
      active: false,
    });

    const res = await patch({ id: 't1', active: true });

    expect(res.status).toBe(400);
    expect(tierUpdateMock).not.toHaveBeenCalled();
  });
});

describe('档位审计日志', () => {
  // P6-15：只写 name + kind 的话，卖 ADMIN 的会员档和卖 PRO 的在审计流水里完全一样——
  // 「档位被偷偷改成授予 ADMIN」事后无从发现。
  it('▶ P6-15 create 的审计明细带 grantRole', async () => {
    await post({
      kind: 'membership',
      name: 'PRO 档',
      priceCents: 100,
      grantRole: 'PRO',
      durationDays: 3650,
    });
    const detail = logActionMock.mock.calls[0][2].detail as string;
    expect(detail).toContain('PRO');
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'recharge.tier.create',
        after: expect.objectContaining({ grantRole: 'PRO' }),
        outcome: 'SUCCESS',
      }),
      txClient
    );
  });

  it('▶ P6-15 update 的审计明细带新旧 grantRole', async () => {
    await patch({ id: 't1', grantRole: 'PRO' });
    const detail = logActionMock.mock.calls[0][2].detail as string;
    expect(detail).toContain('PRO'); // 新值
    expect(detail).toContain('FREE'); // 原值
  });
});
