import { beforeEach, describe, expect, it, vi } from 'vitest';

// 到期提醒回归测试：并发上限、时间预算、去重键在发失败时释放、sent 只统计真正发出的。
//
// 背景：原实现在 500 人候选集上逐个 await 发信，且排在整个维护循环最前面 ——
// SMTP 一慢就把会话回收 / 对账全拖住，15 分钟定时器空跳，维护实质停摆。

const { userFindManyMock, getRedisClientMock, sendExpiryReminderEmailMock, redisSetMock, redisDelMock } =
  vi.hoisted(() => ({
    userFindManyMock: vi.fn(),
    getRedisClientMock: vi.fn(),
    sendExpiryReminderEmailMock: vi.fn(),
    redisSetMock: vi.fn(),
    redisDelMock: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findMany: userFindManyMock } },
}));

vi.mock('@/lib/redis', () => ({
  getRedisClient: getRedisClientMock,
}));

vi.mock('@/lib/email', () => ({
  sendExpiryReminderEmail: sendExpiryReminderEmailMock,
}));

vi.mock('@/lib/userRoles', () => ({
  resolveRoleQuotas: vi.fn(),
  resolveRoleStorageBytesLimit: vi.fn(),
}));

import { sendExpiryReminders } from '@/lib/billingMaintenance';

const NOW = new Date('2026-07-18T00:00:00.000Z');

const makeUsers = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `u${i}`,
    email: `u${i}@example.com`,
    displayName: `用户${i}`,
    emailPreferences: null,
    role: 'PRO',
    roleExpiresAt: new Date('2026-07-22T00:00:00.000Z'),
  }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('sendExpiryReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisSetMock.mockResolvedValue('OK');
    redisDelMock.mockResolvedValue(1);
    getRedisClientMock.mockReturnValue({
      status: 'ready',
      set: redisSetMock,
      del: redisDelMock,
    });
    sendExpiryReminderEmailMock.mockResolvedValue({ ok: true });
  });

  it('正常发送并统计', async () => {
    userFindManyMock.mockResolvedValue(makeUsers(3));

    const sent = await sendExpiryReminders(NOW);

    expect(sent).toBe(3);
    expect(sendExpiryReminderEmailMock).toHaveBeenCalledTimes(3);
    expect(sendExpiryReminderEmailMock.mock.calls[0][1]).toMatchObject({
      planName: 'PRO',
      daysLeft: 4,
    });
  });

  // 核心回归 1：不再是逐个串行，同时在途数受并发上限约束。
  it('并发发送且不超过并发上限', async () => {
    userFindManyMock.mockResolvedValue(makeUsers(20));
    let inFlight = 0;
    let peak = 0;
    sendExpiryReminderEmailMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight -= 1;
      return { ok: true };
    });

    const sent = await sendExpiryReminders(NOW, { concurrency: 4 });

    expect(sent).toBe(20);
    expect(peak).toBeGreaterThan(1); // 确实并发了，不是串行
    expect(peak).toBeLessThanOrEqual(4); // 但不失控
  });

  // 核心回归 2：SMTP 卡死时整体有时间上限，不会把维护循环拖成小时级。
  it('超出时间预算即停止派发，剩余留给下一轮', async () => {
    userFindManyMock.mockResolvedValue(makeUsers(50));
    sendExpiryReminderEmailMock.mockImplementation(async () => {
      await sleep(20); // 模拟慢 SMTP
      return { ok: true };
    });

    const startedAt = Date.now();
    const sent = await sendExpiryReminders(NOW, { concurrency: 2, budgetMs: 60 });
    const elapsed = Date.now() - startedAt;

    expect(sent).toBeLessThan(50); // 没发完
    expect(elapsed).toBeLessThan(1000); // 但很快就收手了，而不是 50×20ms 全跑完
    // 未派发的用户不曾抢过去重键 → 下一轮会原样重新捞到
    expect(redisSetMock.mock.calls.length).toBeLessThan(50);
  });

  // 核心回归 3：去重键是发之前抢的，发失败必须还回去，否则整个到期窗口内再也发不出。
  it('发送失败时释放去重键并且不计入 sent', async () => {
    userFindManyMock.mockResolvedValue(makeUsers(2));
    sendExpiryReminderEmailMock.mockResolvedValue({ ok: false, error: 'SMTP 连接失败' });

    const sent = await sendExpiryReminders(NOW);

    expect(sent).toBe(0);
    expect(redisDelMock).toHaveBeenCalledTimes(2);
    expect(redisDelMock).toHaveBeenCalledWith('email:expiry-reminded:u0:2026-07-22');
  });

  it('抛异常时同样释放去重键', async () => {
    userFindManyMock.mockResolvedValue(makeUsers(1));
    sendExpiryReminderEmailMock.mockRejectedValue(new Error('boom'));

    const sent = await sendExpiryReminders(NOW);

    expect(sent).toBe(0);
    expect(redisDelMock).toHaveBeenCalledWith('email:expiry-reminded:u0:2026-07-22');
  });

  it('用户关闭了到期提醒偏好 → 不计入 sent，但保留去重键（不重试）', async () => {
    userFindManyMock.mockResolvedValue(makeUsers(2));
    sendExpiryReminderEmailMock.mockResolvedValue({ ok: true, error: 'skipped:preference' });

    const sent = await sendExpiryReminders(NOW);

    expect(sent).toBe(0);
    expect(redisDelMock).not.toHaveBeenCalled();
  });

  it('本到期日已提醒过（SET NX 未抢到）→ 跳过且不发信', async () => {
    userFindManyMock.mockResolvedValue(makeUsers(2));
    redisSetMock.mockResolvedValue(null);

    const sent = await sendExpiryReminders(NOW);

    expect(sent).toBe(0);
    expect(sendExpiryReminderEmailMock).not.toHaveBeenCalled();
  });

  it('无 Redis 时整体跳过（无法去重，宁可不发也不 15 分钟轰炸一次）', async () => {
    getRedisClientMock.mockReturnValue(null);

    const sent = await sendExpiryReminders(NOW);

    expect(sent).toBe(0);
    expect(userFindManyMock).not.toHaveBeenCalled();
  });

  it('候选集为空时不起 worker', async () => {
    userFindManyMock.mockResolvedValue([]);

    const sent = await sendExpiryReminders(NOW);

    expect(sent).toBe(0);
    expect(sendExpiryReminderEmailMock).not.toHaveBeenCalled();
  });

  it('部分失败不影响其余用户继续发送', async () => {
    userFindManyMock.mockResolvedValue(makeUsers(4));
    sendExpiryReminderEmailMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'x' })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    const sent = await sendExpiryReminders(NOW, { concurrency: 1 });

    expect(sent).toBe(3);
    expect(sendExpiryReminderEmailMock).toHaveBeenCalledTimes(4);
  });
});
