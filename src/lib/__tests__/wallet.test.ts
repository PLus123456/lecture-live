import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  paymentOrderUpdateManyMock,
  paymentOrderFindUniqueMock,
  paymentOrderCreateMock,
  userUpdateMock,
  userUpdateManyMock,
  userFindUniqueMock,
  walletTxCreateMock,
  rechargeTierFindUniqueMock,
  executeRawMock,
  sendSubscriptionSuccessEmailMock,
} = vi.hoisted(() => ({
  sendSubscriptionSuccessEmailMock: vi.fn(),
  paymentOrderUpdateManyMock: vi.fn(),
  paymentOrderFindUniqueMock: vi.fn(),
  paymentOrderCreateMock: vi.fn(),
  userUpdateMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  walletTxCreateMock: vi.fn(),
  rechargeTierFindUniqueMock: vi.fn(),
  executeRawMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const tx = {
    paymentOrder: {
      updateMany: paymentOrderUpdateManyMock,
      findUnique: paymentOrderFindUniqueMock,
      create: paymentOrderCreateMock,
    },
    user: {
      update: userUpdateMock,
      updateMany: userUpdateManyMock,
      findUnique: userFindUniqueMock,
    },
    walletTransaction: { create: walletTxCreateMock },
    rechargeTier: { findUnique: rechargeTierFindUniqueMock },
    $executeRaw: executeRawMock,
  };
  return {
    prisma: {
      ...tx,
      // $transaction 直接以同一 mock 作为 tx 客户端执行回调。
      // 可被单测替换：真实 Prisma 里「回调跑完」≠「已提交」，要验证提交后才做的副作用
      // （如 #16 的确认邮件）就必须能模拟「回调成功但提交失败」。
      $transaction: (cb: (t: typeof tx) => unknown) => transactionImpl(cb, tx),
    },
  };
});

/**
 * 默认实现＝直接跑回调。测试可临时替换成「跑完回调再抛错」来模拟 COMMIT 阶段失败
 * （死锁、连接断开），从而区分"事务内做的事"与"提交后才做的事"。
 */
type TxRunner = <T>(cb: (t: T) => unknown, tx: T) => unknown;
let transactionImpl: TxRunner = (cb, tx) => cb(tx);
const setTransactionImpl = (impl: TxRunner) => {
  transactionImpl = impl;
};
const resetTransactionImpl = () => {
  transactionImpl = (cb, tx) => cb(tx);
};

vi.mock('@/lib/userRoles', () => ({
  resolveRoleQuotas: vi.fn().mockResolvedValue({
    transcriptionMinutesLimit: 600,
    storageHoursLimit: 100,
    allowedModels: 'local,gpt,deepseek',
  }),
  resolveRoleStorageBytesLimit: vi.fn().mockResolvedValue(BigInt(1024 * 1024 * 1024)),
}));

vi.mock('@/lib/auditLog', () => ({
  logSystemEvent: vi.fn(),
}));

vi.mock('@/lib/email', () => ({
  sendSubscriptionSuccessEmail: sendSubscriptionSuccessEmailMock,
}));

import { creditPaidOrder, spendFromBalance, adminAdjust, WalletError } from '@/lib/wallet';

beforeEach(() => {
  resetTransactionImpl(); // 防止「提交失败」替身泄漏到其它用例
  paymentOrderUpdateManyMock.mockReset();
  paymentOrderFindUniqueMock.mockReset();
  userUpdateMock.mockReset();
  userUpdateManyMock.mockReset();
  userFindUniqueMock.mockReset();
  walletTxCreateMock.mockReset();
  rechargeTierFindUniqueMock.mockReset();
  executeRawMock.mockReset();
  sendSubscriptionSuccessEmailMock.mockReset();
  sendSubscriptionSuccessEmailMock.mockResolvedValue({ ok: true });
  userUpdateMock.mockResolvedValue({ walletBalanceCents: 0 });
  // 条件扣款守卫默认扣款成功（余额充足）；余额不足的用例各自覆盖为 { count: 0 }。
  userUpdateManyMock.mockResolvedValue({ count: 1 });
  walletTxCreateMock.mockResolvedValue({});
});

describe('creditPaidOrder：幂等到账', () => {
  it('▶ 充值订单：认领成功 → 钱包 += creditCents + topup 台账', async () => {
    paymentOrderUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    paymentOrderFindUniqueMock.mockResolvedValueOnce({
      id: 'o1',
      userId: 'u1',
      kind: 'topup',
      tierId: null,
      amountCents: 1000,
      status: 'paid',
      metadataJson: JSON.stringify({ creditCents: 1200, returnUrl: '/x' }), // 充1000送200
    });
    userUpdateMock.mockResolvedValueOnce({ walletBalanceCents: 1200 });

    const res = await creditPaidOrder('LLABC', 'ref-1');
    expect(res.ok).toBe(true);
    expect(res.alreadyProcessed).toBe(false);
    expect(userUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { walletBalanceCents: { increment: 1200 } } })
    );
    expect(walletTxCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'topup', amountCents: 1200, balanceAfterCents: 1200 }),
      })
    );
  });

  it('▶ 重复回调：CAS count=0 → 幂等，不再加余额/记账', async () => {
    paymentOrderUpdateManyMock.mockResolvedValueOnce({ count: 0 });
    paymentOrderFindUniqueMock.mockResolvedValueOnce({
      id: 'o1',
      userId: 'u1',
      kind: 'topup',
      amountCents: 1000,
      status: 'paid',
      metadataJson: JSON.stringify({ creditCents: 1000 }),
    });

    const res = await creditPaidOrder('LLABC');
    expect(res.alreadyProcessed).toBe(true);
    expect(res.ok).toBe(true);
    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(walletTxCreateMock).not.toHaveBeenCalled();
  });

  it('▶ 订单不存在：ok:false', async () => {
    paymentOrderUpdateManyMock.mockResolvedValueOnce({ count: 0 });
    paymentOrderFindUniqueMock.mockResolvedValueOnce(null);
    const res = await creditPaidOrder('LLNONE');
    expect(res.ok).toBe(false);
  });

  it('▶ M1/M2 金额不符：拒绝到账（不认领、不加余额）', async () => {
    paymentOrderFindUniqueMock.mockResolvedValueOnce({
      id: 'o-amt',
      userId: 'u1',
      kind: 'topup',
      tierId: null,
      amountCents: 1000,
      status: 'pending',
      metadataJson: JSON.stringify({ creditCents: 1000 }),
    });
    // 网关回报实付 1 分（≠ 订单 1000 分）→ 拒绝到账。
    const res = await creditPaidOrder('LLAMT', 'ref', 'alipay', 1);
    expect(res.ok).toBe(false);
    expect(paymentOrderUpdateManyMock).not.toHaveBeenCalled(); // 未认领
    expect(userUpdateMock).not.toHaveBeenCalled(); // 未加余额
  });

  it('▶ M1/M2 金额一致：正常到账', async () => {
    paymentOrderFindUniqueMock.mockResolvedValueOnce({
      id: 'o-amt2',
      userId: 'u1',
      kind: 'topup',
      tierId: null,
      amountCents: 1000,
      status: 'pending',
      metadataJson: JSON.stringify({ creditCents: 1000 }),
    });
    paymentOrderUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    userUpdateMock.mockResolvedValueOnce({ walletBalanceCents: 1000 });

    const res = await creditPaidOrder('LLAMT2', 'ref', 'alipay', 1000);
    expect(res.ok).toBe(true);
    expect(userUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { walletBalanceCents: { increment: 1000 } } })
    );
  });

  it('▶ H3 渠道绑定：认领 CAS 带 provider 过滤（防跨渠道/沙箱替真单结算）', async () => {
    paymentOrderUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    paymentOrderFindUniqueMock.mockResolvedValueOnce({
      id: 'o-prov',
      userId: 'u1',
      kind: 'topup',
      tierId: null,
      amountCents: 1000,
      status: 'paid',
      metadataJson: JSON.stringify({ creditCents: 1000 }),
    });
    userUpdateMock.mockResolvedValueOnce({ walletBalanceCents: 1000 });

    await creditPaidOrder('LLPROV', 'ref', 'stripe');
    expect(paymentOrderUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          outTradeNo: 'LLPROV',
          status: 'pending',
          provider: 'stripe',
        }),
      })
    );
  });

  it('▶ 直接购买时间档位：进账 + 等额出账 + 加永久池', async () => {
    paymentOrderUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    paymentOrderFindUniqueMock.mockResolvedValueOnce({
      id: 'o2',
      userId: 'u1',
      kind: 'purchase',
      tierId: 't-min',
      amountCents: 5000,
      status: 'paid',
      metadataJson: JSON.stringify({ creditCents: 5000 }),
    });
    rechargeTierFindUniqueMock.mockResolvedValueOnce({
      id: 't-min',
      kind: 'minutes',
      name: '600分钟包',
      priceCents: 5000,
      grantMinutes: 600,
      active: true,
    });
    userFindUniqueMock.mockResolvedValueOnce({
      walletBalanceCents: 5000, // 进账后余额足够
      role: 'FREE',
      originalRole: null,
      roleExpiresAt: null,
    });

    await creditPaidOrder('LLBUY');

    // 加永久时长池 600
    expect(userUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { purchasedMinutesBalance: { increment: 600 } } })
    );
    // 两笔台账：topup(+) 与 purchase_minutes(-)
    const types = walletTxCreateMock.mock.calls.map((c) => c[0].data.type);
    expect(types).toContain('topup');
    expect(types).toContain('purchase_minutes');
  });

  it('▶ H1/H2 购买按订单冻结快照发放，不读 live 档位（档位删/改价均无碍）', async () => {
    paymentOrderUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    paymentOrderFindUniqueMock.mockResolvedValueOnce({
      id: 'o-snap',
      userId: 'u1',
      kind: 'purchase',
      tierId: 't-min',
      amountCents: 5000,
      status: 'paid',
      metadataJson: JSON.stringify({
        creditCents: 5000,
        grant: {
          kind: 'minutes',
          priceCents: 5000,
          tierId: 't-min',
          tierName: '600分钟包',
          grantMinutes: 600,
        },
      }),
    });
    userFindUniqueMock
      .mockResolvedValueOnce({
        walletBalanceCents: 5000,
        role: 'FREE',
        originalRole: null,
        roleExpiresAt: null,
      })
      .mockResolvedValueOnce({ walletBalanceCents: 0 });
    userUpdateManyMock.mockResolvedValueOnce({ count: 1 });

    const res = await creditPaidOrder('LLSNAP');
    expect(res.ok).toBe(true);
    // 关键（H1/H2）：未读 live 档位——发放全凭订单冻结快照。
    expect(rechargeTierFindUniqueMock).not.toHaveBeenCalled();
    // 扣款守卫用快照冻结价 5000（H2）。
    expect(userUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 'u1', walletBalanceCents: { gte: 5000 } },
      data: { walletBalanceCents: { decrement: 5000 } },
    });
    // 按快照 grantMinutes 加池 600。
    expect(userUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { purchasedMinutesBalance: { increment: 600 } } })
    );
  });

  it('▶ H1 发放失败不回滚已到账余额（钱留钱包，回调仍成功，不再无限重试）', async () => {
    paymentOrderUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    paymentOrderFindUniqueMock.mockResolvedValueOnce({
      id: 'o-fail',
      userId: 'u1',
      kind: 'purchase',
      tierId: 't-min',
      amountCents: 5000,
      status: 'paid',
      metadataJson: JSON.stringify({
        creditCents: 5000,
        grant: {
          kind: 'minutes',
          priceCents: 5000,
          tierId: 't-min',
          tierName: 'X',
          grantMinutes: 600,
        },
      }),
    });
    // tx1 到账：credit user.update 返回新余额（记 topup）。
    userUpdateMock.mockResolvedValueOnce({ walletBalanceCents: 5000 });
    // tx2 发放：user.findUnique 返回 null → applyGrantTx 抛 user_not_found → 被吞（不回滚到账）。
    userFindUniqueMock.mockResolvedValueOnce(null);

    const res = await creditPaidOrder('LLFAIL');

    // 回调据 tx1 到账成功照常返回 ok（网关停止重试）。
    expect(res.ok).toBe(true);
    expect(res.alreadyProcessed).toBe(false);
    const types = walletTxCreateMock.mock.calls.map((c) => c[0].data.type);
    expect(types).toContain('topup'); // 钱已入账、保留
    expect(types).not.toContain('purchase_minutes'); // 发放失败，无出账台账
  });
});

describe('spendFromBalance：余额购买', () => {
  it('▶ 余额不足 → 抛 WalletError(insufficient_balance)', async () => {
    rechargeTierFindUniqueMock.mockResolvedValueOnce({
      id: 't1',
      kind: 'minutes',
      name: 'x',
      priceCents: 5000,
      grantMinutes: 600,
      active: true,
    });
    userFindUniqueMock.mockResolvedValueOnce({
      walletBalanceCents: 100,
      role: 'FREE',
      originalRole: null,
      roleExpiresAt: null,
    });
    // 条件扣款守卫：余额不足时 WHERE gte 不命中 → count=0。
    userUpdateManyMock.mockResolvedValueOnce({ count: 0 });
    await expect(spendFromBalance('u1', 't1')).rejects.toMatchObject({
      code: 'insufficient_balance',
    });
    // 守卫未命中，不得发放档位（不调用 user.update）。
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('▶ C1 防并发双花：扣款用条件 updateMany(walletBalanceCents gte price) 而非盲扣', async () => {
    rechargeTierFindUniqueMock.mockResolvedValueOnce({
      id: 't-min',
      kind: 'minutes',
      name: '600分钟包',
      priceCents: 5000,
      grantMinutes: 600,
      active: true,
    });
    userFindUniqueMock
      .mockResolvedValueOnce({
        walletBalanceCents: 5000,
        role: 'FREE',
        originalRole: null,
        roleExpiresAt: null,
      })
      .mockResolvedValueOnce({ walletBalanceCents: 0 }); // 扣款后 balanceAfter 复读
    userUpdateManyMock.mockResolvedValueOnce({ count: 1 });

    await spendFromBalance('u1', 't-min');

    // 关键断言：扣款必须带 balance>=price 的守卫，否则并发下会被扣穿（回归即失败）。
    expect(userUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 'u1', walletBalanceCents: { gte: 5000 } },
      data: { walletBalanceCents: { decrement: 5000 } },
    });
    // 且不得再用无守卫的 user.update 扣余额（只允许 update 发放档位/续期）。
    const balanceDecrementViaUpdate = userUpdateMock.mock.calls.some(
      (c) => c[0]?.data?.walletBalanceCents?.decrement !== undefined
    );
    expect(balanceDecrementViaUpdate).toBe(false);
  });

  it('▶ 会员档位：扣余额 + 设 role/originalRole/roleExpiresAt + purchase_membership 台账', async () => {
    rechargeTierFindUniqueMock.mockResolvedValueOnce({
      id: 't-pro',
      kind: 'membership',
      name: 'PRO月卡',
      priceCents: 3000,
      grantRole: 'PRO',
      durationDays: 30,
      active: true,
    });
    userFindUniqueMock.mockResolvedValueOnce({
      walletBalanceCents: 3000,
      role: 'FREE',
      originalRole: null,
      roleExpiresAt: null,
    });
    userUpdateMock.mockResolvedValue({ walletBalanceCents: 0 });

    await spendFromBalance('u1', 't-pro');

    // 第二次 user.update 应设 role=PRO、originalRole=FREE、roleExpiresAt 非空
    const roleUpdate = userUpdateMock.mock.calls.find(
      (c) => c[0].data?.role === 'PRO'
    );
    expect(roleUpdate).toBeTruthy();
    expect(roleUpdate?.[0].data.originalRole).toBe('FREE');
    expect(roleUpdate?.[0].data.roleExpiresAt).toBeInstanceOf(Date);
    expect(roleUpdate?.[0].data.customGroupId).toBeNull();
    const memberTx = walletTxCreateMock.mock.calls.find(
      (c) => c[0].data.type === 'purchase_membership'
    );
    expect(memberTx?.[0].data.amountCents).toBe(-3000);
  });

  it('▶ M3 永久提权用户买同级会员：回退目标保留当前角色（不被抹成 FREE）', async () => {
    rechargeTierFindUniqueMock.mockResolvedValueOnce({
      id: 't-pro',
      kind: 'membership',
      name: 'PRO月卡',
      priceCents: 3000,
      grantRole: 'PRO',
      durationDays: 30,
      active: true,
    });
    // 永久 PRO（admin 授予）：role=PRO, originalRole=null, roleExpiresAt=null。
    userFindUniqueMock
      .mockResolvedValueOnce({
        walletBalanceCents: 3000,
        role: 'PRO',
        originalRole: null,
        roleExpiresAt: null,
      })
      .mockResolvedValueOnce({ walletBalanceCents: 0 });
    userUpdateManyMock.mockResolvedValueOnce({ count: 1 });

    await spendFromBalance('perm-pro', 't-pro');

    const roleUpdate = userUpdateMock.mock.calls.find((c) => c[0].data?.role === 'PRO');
    // 关键：回退目标是 PRO（永久权益保留），不是 FREE。
    expect(roleUpdate?.[0].data.originalRole).toBe('PRO');
  });

  it('▶ ADMIN 买会员 → 拒绝', async () => {
    rechargeTierFindUniqueMock.mockResolvedValueOnce({
      id: 't-pro',
      kind: 'membership',
      name: 'PRO',
      priceCents: 3000,
      grantRole: 'PRO',
      durationDays: 30,
      active: true,
    });
    userFindUniqueMock.mockResolvedValueOnce({
      walletBalanceCents: 999999,
      role: 'ADMIN',
      originalRole: null,
      roleExpiresAt: null,
    });
    await expect(spendFromBalance('admin', 't-pro')).rejects.toMatchObject({
      code: 'admin_no_membership',
    });
  });

  // #16：余额购买此前完全不发确认信 —— 钱扣了、角色变了、tokenVersion++ 还把人踢下线，
  // 用户零通知。网关支付有信，纯余额出账没有，同一笔消费两条路径待遇不同。
  it('▶ #16 会员档位购买成功后发确认邮件（含真实到期日）', async () => {
    rechargeTierFindUniqueMock.mockResolvedValueOnce({
      id: 't-pro',
      kind: 'membership',
      name: 'PRO月卡',
      priceCents: 3000,
      grantRole: 'PRO',
      durationDays: 30,
      active: true,
    });
    userFindUniqueMock
      .mockResolvedValueOnce({
        walletBalanceCents: 3000,
        role: 'FREE',
        originalRole: null,
        roleExpiresAt: null,
      })
      .mockResolvedValueOnce({ walletBalanceCents: 0 })
      // notifyBalancePurchase 事务后重新读用户，拿发放后的到期日
      .mockResolvedValueOnce({
        id: 'u1',
        email: 'u1@example.com',
        displayName: '张三',
        emailPreferences: null,
        roleExpiresAt: new Date('2026-08-17T00:00:00.000Z'),
      });
    userUpdateManyMock.mockResolvedValueOnce({ count: 1 });

    await spendFromBalance('u1', 't-pro');
    // fire-and-forget：排空微任务再断言
    await new Promise((r) => setTimeout(r, 0));

    expect(sendSubscriptionSuccessEmailMock).toHaveBeenCalledTimes(1);
    const [user, params] = sendSubscriptionSuccessEmailMock.mock.calls[0];
    expect(user).toMatchObject({ id: 'u1', email: 'u1@example.com' });
    expect(params).toMatchObject({ planName: 'PRO月卡', amountLabel: '¥30.00' });
    expect(params.expiresLabel).toBeTruthy();
  });

  it('▶ #16 分钟包购买同样发确认信，但不写有效期', async () => {
    rechargeTierFindUniqueMock.mockResolvedValueOnce({
      id: 't-min',
      kind: 'minutes',
      name: '600分钟包',
      priceCents: 5000,
      grantMinutes: 600,
      active: true,
    });
    userFindUniqueMock
      .mockResolvedValueOnce({
        walletBalanceCents: 5000,
        role: 'FREE',
        originalRole: null,
        roleExpiresAt: null,
      })
      .mockResolvedValueOnce({ walletBalanceCents: 0 })
      .mockResolvedValueOnce({
        id: 'u1',
        email: 'u1@example.com',
        displayName: '张三',
        emailPreferences: null,
        // 分钟包不动角色，用户可能本来就有会员到期日——也绝不能拿它当本次购买的有效期
        roleExpiresAt: new Date('2026-09-01T00:00:00.000Z'),
      });
    userUpdateManyMock.mockResolvedValueOnce({ count: 1 });

    await spendFromBalance('u1', 't-min');
    await new Promise((r) => setTimeout(r, 0));

    expect(sendSubscriptionSuccessEmailMock).toHaveBeenCalledTimes(1);
    expect(sendSubscriptionSuccessEmailMock.mock.calls[0][1].expiresLabel).toBeNull();
  });

  // 事务失败=没买成，绝不能发确认信（同 #3 的教训）。
  it('▶ #16 购买失败时不发确认邮件', async () => {
    rechargeTierFindUniqueMock.mockResolvedValueOnce({
      id: 't1',
      kind: 'minutes',
      name: 'x',
      priceCents: 5000,
      grantMinutes: 600,
      active: true,
    });
    userFindUniqueMock.mockResolvedValueOnce({
      walletBalanceCents: 100,
      role: 'FREE',
      originalRole: null,
      roleExpiresAt: null,
    });
    userUpdateManyMock.mockResolvedValueOnce({ count: 0 });

    await expect(spendFromBalance('u1', 't1')).rejects.toMatchObject({
      code: 'insufficient_balance',
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(sendSubscriptionSuccessEmailMock).not.toHaveBeenCalled();
  });

  // 变异测试抓出来的漏网之鱼：把发信挪进事务回调里，上面那些断言全都照样绿 ——
  // 因为 $transaction 替身只是原地跑回调，区分不了「事务内」与「已提交」。
  // 这里显式模拟「回调成功但 COMMIT 失败」：确认信必须一封都发不出去，
  // 否则用户会收到一封「购买成功」而钱和权益其实都回滚了。
  it('▶ #16 事务提交失败时不发确认邮件（发信必须在提交之后）', async () => {
    setTransactionImpl(async (cb, tx) => {
      await cb(tx); // 回调本身成功
      throw new Error('commit failed'); // 提交阶段炸了 → 整笔回滚
    });

    rechargeTierFindUniqueMock.mockResolvedValueOnce({
      id: 't-min',
      kind: 'minutes',
      name: '600分钟包',
      priceCents: 5000,
      grantMinutes: 600,
      active: true,
    });
    userFindUniqueMock
      .mockResolvedValueOnce({
        walletBalanceCents: 5000,
        role: 'FREE',
        originalRole: null,
        roleExpiresAt: null,
      })
      .mockResolvedValueOnce({ walletBalanceCents: 0 })
      .mockResolvedValueOnce({
        id: 'u1',
        email: 'u1@example.com',
        displayName: '张三',
        emailPreferences: null,
        roleExpiresAt: null,
      });
    userUpdateManyMock.mockResolvedValueOnce({ count: 1 });

    await expect(spendFromBalance('u1', 't-min')).rejects.toThrow('commit failed');
    await new Promise((r) => setTimeout(r, 0));

    expect(sendSubscriptionSuccessEmailMock).not.toHaveBeenCalled();
  });

  // 发信失败不能反过来把已成功的购买变成失败。
  it('▶ #16 发信失败不影响购买本身', async () => {
    sendSubscriptionSuccessEmailMock.mockRejectedValueOnce(new Error('smtp down'));
    rechargeTierFindUniqueMock.mockResolvedValueOnce({
      id: 't-min',
      kind: 'minutes',
      name: '600分钟包',
      priceCents: 5000,
      grantMinutes: 600,
      active: true,
    });
    userFindUniqueMock
      .mockResolvedValueOnce({
        walletBalanceCents: 5000,
        role: 'FREE',
        originalRole: null,
        roleExpiresAt: null,
      })
      .mockResolvedValueOnce({ walletBalanceCents: 0 })
      .mockResolvedValueOnce({
        id: 'u1',
        email: 'u1@example.com',
        displayName: '张三',
        emailPreferences: null,
        roleExpiresAt: null,
      });
    userUpdateManyMock.mockResolvedValueOnce({ count: 1 });

    await expect(spendFromBalance('u1', 't-min')).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('adminAdjust：管理员手动调整', () => {
  it('▶ 同时加余额与时长 → admin_adjust 台账（含 minutesDelta）', async () => {
    userFindUniqueMock.mockResolvedValueOnce({ walletBalanceCents: 500 });
    userUpdateMock.mockResolvedValueOnce({ walletBalanceCents: 1500 });

    await adminAdjust({
      userId: 'u1',
      amountCentsDelta: 1000,
      minutesDelta: 200,
      note: '补偿',
      operatorId: 'admin-1',
    });

    expect(walletTxCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'admin_adjust',
          amountCents: 1000,
          minutesDelta: 200,
          operatorId: 'admin-1',
          note: '补偿',
        }),
      })
    );
  });

  it('▶ 负向余额调整不减到负数（按当前余额截断）', async () => {
    userFindUniqueMock.mockResolvedValueOnce({ walletBalanceCents: 300 });
    userUpdateMock.mockResolvedValueOnce({ walletBalanceCents: 0 });

    await adminAdjust({ userId: 'u1', amountCentsDelta: -1000, operatorId: 'admin-1' });

    // 只扣 300（截断），台账 amountCents = -300
    expect(userUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { walletBalanceCents: { increment: -300 } } })
    );
    expect(walletTxCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amountCents: -300 }) })
    );
  });

  it('▶ 空调整 → 抛错', async () => {
    await expect(
      adminAdjust({ userId: 'u1', operatorId: 'admin-1' })
    ).rejects.toBeInstanceOf(WalletError);
  });

  it('▶ M4 负向时长超池：按池截断，台账记实际生效值（非请求值）', async () => {
    userFindUniqueMock.mockResolvedValueOnce({
      walletBalanceCents: 0,
      purchasedMinutesBalance: 5,
    });
    // 池只有 5，请求扣 100 → 实际只扣 5。
    await adminAdjust({ userId: 'u1', minutesDelta: -100, operatorId: 'admin-1' });
    // 台账记实际生效 -5（而非请求 -100），避免审计虚报。
    expect(walletTxCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ minutesDelta: -5 }),
      })
    );
    // 池扣减用 GREATEST raw 防负。
    expect(executeRawMock).toHaveBeenCalled();
  });
});

/**
 * 「订阅成功」通知邮件的发送条件。
 *
 * 回归背景：notifyOrderCredited 原本排在 tx2 的 try/catch **外面**无条件触发，于是发放失败
 * （档位被删/管理员账号/并发扣光余额）时用户照样收到「订阅成功」，且因为 roleExpiresAt 仍为空
 * 被渲染成「有效期至：永久有效」—— 把最糟的结果显示成最好的结果。
 */
describe('creditPaidOrder：订阅成功通知邮件', () => {
  const NOTIFY_USER = {
    id: 'u1',
    email: 'buyer@example.com',
    displayName: '买家',
    emailPreferences: null,
  };

  // notifyOrderCredited 是 fire-and-forget（void + catch），creditPaidOrder 不等它。
  // 断言前必须排空微任务队列 —— 否则「不该发信」那条会因为发信还没来得及发生而空过。
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('▶ 发放失败 → 绝不发「订阅成功」邮件', async () => {
    const failedOrder = {
      id: 'o-fail',
      userId: 'u1',
      kind: 'purchase',
      tierId: 't-gone',
      amountCents: 3900,
      status: 'paid',
      metadataJson: JSON.stringify({ creditCents: 3900 }), // 无 grant 快照
    };
    paymentOrderUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    // 两次都要给：creditPaidOrder 认领后读一次，notifyOrderCredited 还会重新读一次。
    // 若只给一次，notify 会在第二次拿到 undefined 后提前 return —— 那样即便删掉防线本用例
    // 也照样"通过"，成为一条永远绿的假测试。
    paymentOrderFindUniqueMock
      .mockResolvedValueOnce(failedOrder)
      .mockResolvedValueOnce(failedOrder);
    // 档位已被删除 → resolveTierGrant 返回 null → applyGrantTx 之前就抛 tier_unavailable
    rechargeTierFindUniqueMock.mockResolvedValueOnce(null);
    // 用户查得到：确保"没发信"只可能是防线起了作用，而不是数据缺失导致的提前返回。
    userFindUniqueMock.mockResolvedValueOnce({ ...NOTIFY_USER, roleExpiresAt: null });

    const res = await creditPaidOrder('LLGRANTFAIL');
    await flush();

    // 钱已到账（不回滚），但发放没成功
    expect(res.ok).toBe(true);
    expect(sendSubscriptionSuccessEmailMock).not.toHaveBeenCalled();
  });

  it('▶ 会员发放成功 → 发信且写真实到期日', async () => {
    const expiry = new Date('2026-08-18T00:00:00Z');
    paymentOrderUpdateManyMock.mockResolvedValue({ count: 1 });
    paymentOrderFindUniqueMock
      .mockResolvedValueOnce({
        id: 'o-ok',
        userId: 'u1',
        kind: 'purchase',
        tierId: 't-pro',
        amountCents: 3900,
        status: 'paid',
        metadataJson: JSON.stringify({
          creditCents: 3900,
          grant: {
            kind: 'membership',
            priceCents: 3900,
            tierId: 't-pro',
            tierName: 'PRO 月卡',
            grantRole: 'PRO',
            durationDays: 30,
          },
        }),
      })
      // notifyOrderCredited 会重新读一次订单
      .mockResolvedValueOnce({
        id: 'o-ok',
        userId: 'u1',
        kind: 'purchase',
        amountCents: 3900,
        metadataJson: JSON.stringify({
          grant: { kind: 'membership', tierName: 'PRO 月卡' },
        }),
      });
    userFindUniqueMock
      .mockResolvedValueOnce({ walletBalanceCents: 3900, role: 'FREE', originalRole: null, roleExpiresAt: null })
      .mockResolvedValueOnce({ walletBalanceCents: 0 })
      .mockResolvedValueOnce({ ...NOTIFY_USER, roleExpiresAt: expiry });

    await creditPaidOrder('LLOK');
    await flush();

    expect(sendSubscriptionSuccessEmailMock).toHaveBeenCalledTimes(1);
    const [user, params] = sendSubscriptionSuccessEmailMock.mock.calls[0];
    expect(user).toMatchObject({ id: 'u1', email: 'buyer@example.com' });
    expect(params.planName).toBe('PRO 月卡');
    expect(params.amountLabel).toBe('¥39.00');
    expect(params.expiresLabel).toBe(expiry.toLocaleDateString('zh-CN'));
  });

  // 纵深防御：即便某天异常态走到了这里，也不许把「没有到期日」说成「永久有效」。
  it('▶ 会员单但到期日为空 → 省略有效期，不得写「永久有效」', async () => {
    paymentOrderUpdateManyMock.mockResolvedValue({ count: 1 });
    paymentOrderFindUniqueMock
      .mockResolvedValueOnce({
        id: 'o-noexp',
        userId: 'u1',
        kind: 'purchase',
        tierId: 't-pro',
        amountCents: 3900,
        status: 'paid',
        metadataJson: JSON.stringify({
          creditCents: 3900,
          grant: {
            kind: 'membership',
            priceCents: 3900,
            tierId: 't-pro',
            tierName: 'PRO 月卡',
            grantRole: 'PRO',
            durationDays: 30,
          },
        }),
      })
      .mockResolvedValueOnce({
        id: 'o-noexp',
        userId: 'u1',
        kind: 'purchase',
        amountCents: 3900,
        metadataJson: JSON.stringify({
          grant: { kind: 'membership', tierName: 'PRO 月卡' },
        }),
      });
    userFindUniqueMock
      .mockResolvedValueOnce({ walletBalanceCents: 3900, role: 'FREE', originalRole: null, roleExpiresAt: null })
      .mockResolvedValueOnce({ walletBalanceCents: 0 })
      .mockResolvedValueOnce({ ...NOTIFY_USER, roleExpiresAt: null });

    await creditPaidOrder('LLNOEXP');
    await flush();

    expect(sendSubscriptionSuccessEmailMock).toHaveBeenCalledTimes(1);
    const params = sendSubscriptionSuccessEmailMock.mock.calls[0][1];
    expect(params.expiresLabel).toBeNull();
    expect(params.expiresLabel).not.toBe('永久有效');
  });

  it('▶ 纯充值订单（无发放环节）→ 照常发信', async () => {
    paymentOrderUpdateManyMock.mockResolvedValue({ count: 1 });
    paymentOrderFindUniqueMock
      .mockResolvedValueOnce({
        id: 'o-top',
        userId: 'u1',
        kind: 'topup',
        tierId: null,
        amountCents: 10000,
        status: 'paid',
        metadataJson: JSON.stringify({ creditCents: 12000 }),
      })
      .mockResolvedValueOnce({
        id: 'o-top',
        userId: 'u1',
        kind: 'topup',
        amountCents: 10000,
        metadataJson: JSON.stringify({}),
      });
    userUpdateMock.mockResolvedValueOnce({ walletBalanceCents: 12000 });
    userFindUniqueMock.mockResolvedValueOnce({ ...NOTIFY_USER, roleExpiresAt: null });

    await creditPaidOrder('LLTOP');
    await flush();

    expect(sendSubscriptionSuccessEmailMock).toHaveBeenCalledTimes(1);
    const params = sendSubscriptionSuccessEmailMock.mock.calls[0][1];
    expect(params.planName).toBe('钱包充值');
    expect(params.expiresLabel).toBeNull();
  });
});
