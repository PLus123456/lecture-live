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
} = vi.hoisted(() => ({
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
      $transaction: (cb: (t: typeof tx) => unknown) => cb(tx),
    },
  };
});

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

import { creditPaidOrder, spendFromBalance, adminAdjust, WalletError } from '@/lib/wallet';

beforeEach(() => {
  paymentOrderUpdateManyMock.mockReset();
  paymentOrderFindUniqueMock.mockReset();
  userUpdateMock.mockReset();
  userUpdateManyMock.mockReset();
  userFindUniqueMock.mockReset();
  walletTxCreateMock.mockReset();
  rechargeTierFindUniqueMock.mockReset();
  executeRawMock.mockReset();
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
