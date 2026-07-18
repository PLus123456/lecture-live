import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #14：群发是 sendGenericNotificationEmail 的唯一调用方。
 * 重点验两件事：收件人筛选口径（已验证 + 未退订 + 总开关），以及派发不会串行卡死。
 */

const { findManyMock, sendGenericNotificationEmailMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  sendGenericNotificationEmailMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findMany: findManyMock } },
}));
vi.mock('@/lib/email', () => ({
  sendGenericNotificationEmail: sendGenericNotificationEmailMock,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => e,
}));

import {
  findBroadcastRecipients,
  runBroadcast,
  BROADCAST_MAX_RECIPIENTS,
} from '@/lib/email/broadcast';
import type { SiteSettings } from '@/lib/siteSettings';

const SETTINGS = { marketing_emails_enabled: true } as unknown as SiteSettings;
const SETTINGS_MARKETING_OFF = {
  marketing_emails_enabled: false,
} as unknown as SiteSettings;

const CONTENT = {
  category: 'product_updates' as const,
  subject: 's',
  heading: 'h',
  bodyText: 'b',
};

function user(id: string, emailPreferences: string | null = null) {
  return { id, email: `${id}@example.com`, displayName: id, emailPreferences };
}

describe('findBroadcastRecipients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findManyMock.mockResolvedValue([user('a'), user('b')]);
  });

  // 给从未验证过的地址发营销信会推高退信率、伤投递声誉。
  it('只查「正常 + 邮箱已验证」的用户', async () => {
    await findBroadcastRecipients('all', 'product_updates', SETTINGS);
    expect(findManyMock.mock.calls[0][0].where).toMatchObject({
      status: 1,
      emailVerifiedAt: { not: null },
    });
  });

  it('按角色筛选时带上 role 条件，all 则不带', async () => {
    await findBroadcastRecipients('PRO', 'product_updates', SETTINGS);
    expect(findManyMock.mock.calls[0][0].where).toMatchObject({ role: 'PRO' });

    findManyMock.mockClear();
    await findBroadcastRecipients('all', 'product_updates', SETTINGS);
    expect(findManyMock.mock.calls[0][0].where.role).toBeUndefined();
  });

  it('剔除已退订该分类的用户', async () => {
    findManyMock.mockResolvedValue([
      user('keep'),
      user('optedout', '{"product_updates":false}'),
      user('otherOptOut', '{"promotions":false}'), // 退的是别的分类，仍应收到
    ]);

    const { users } = await findBroadcastRecipients('all', 'product_updates', SETTINGS);
    expect(users.map((u) => u.id)).toEqual(['keep', 'otherOptOut']);
  });

  // 站点总开关关着时预览必须是 0，否则管理员看到"将发给 N 人"却一封也发不出。
  it('营销总开关关闭时收件人为空', async () => {
    const { users } = await findBroadcastRecipients(
      'all',
      'promotions',
      SETTINGS_MARKETING_OFF
    );
    expect(users).toEqual([]);
  });

  // 静默截断会让管理员以为"全发到了"。
  it('超过上限时如实上报 truncated', async () => {
    findManyMock.mockResolvedValue(
      Array.from({ length: BROADCAST_MAX_RECIPIENTS + 1 }, (_, i) => user(`u${i}`))
    );
    const { users, truncated } = await findBroadcastRecipients(
      'all',
      'product_updates',
      SETTINGS
    );
    expect(truncated).toBe(true);
    expect(users).toHaveLength(BROADCAST_MAX_RECIPIENTS);
  });

  it('未超上限时 truncated 为 false', async () => {
    const { truncated } = await findBroadcastRecipients('all', 'product_updates', SETTINGS);
    expect(truncated).toBe(false);
  });
});

describe('runBroadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendGenericNotificationEmailMock.mockResolvedValue({ ok: true });
  });

  it('逐人发送并统计', async () => {
    const users = [user('a'), user('b'), user('c')];
    const r = await runBroadcast(users, CONTENT, SETTINGS, { concurrency: 2 });
    expect(r).toMatchObject({ sent: 3, skipped: 0, failed: 0 });
    expect(sendGenericNotificationEmailMock).toHaveBeenCalledTimes(3);
  });

  it('区分「偏好跳过」与「发送失败」', async () => {
    sendGenericNotificationEmailMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, error: 'skipped:preference' })
      .mockResolvedValueOnce({ ok: false, error: 'smtp down' });

    const r = await runBroadcast([user('a'), user('b'), user('c')], CONTENT, SETTINGS, {
      concurrency: 1,
    });
    expect(r).toMatchObject({ sent: 1, skipped: 1, failed: 1 });
  });

  it('单封抛错不中断整批', async () => {
    sendGenericNotificationEmailMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ ok: true });

    const r = await runBroadcast([user('a'), user('b'), user('c')], CONTENT, SETTINGS, {
      concurrency: 1,
    });
    expect(r.failed).toBe(1);
    expect(r.sent).toBe(2);
  });

  // 审计 #5 的教训：500 人串行 await SMTP = 单轮 1.4 小时。并发必须真的并发。
  it('并发派发而不是串行', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    sendGenericNotificationEmailMock.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { ok: true };
    });

    await runBroadcast(
      Array.from({ length: 10 }, (_, i) => user(`u${i}`)),
      CONTENT,
      SETTINGS,
      { concurrency: 4 }
    );
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  // 预算耗尽必须停下并如实上报，否则 SMTP 挂掉时这个任务会挂很久。
  it('超出时间预算即停止派发并上报', async () => {
    sendGenericNotificationEmailMock.mockImplementation(
      () => new Promise((r) => setTimeout(() => r({ ok: true }), 30))
    );

    const r = await runBroadcast(
      Array.from({ length: 50 }, (_, i) => user(`u${i}`)),
      CONTENT,
      SETTINGS,
      { concurrency: 1, budgetMs: 50 }
    );

    expect(r.budgetExhausted).toBe(true);
    expect(r.sent).toBeLessThan(50);
  });

  it('收件人为空时不发信也不报错', async () => {
    const r = await runBroadcast([], CONTENT, SETTINGS);
    expect(r).toMatchObject({ sent: 0, failed: 0 });
    expect(sendGenericNotificationEmailMock).not.toHaveBeenCalled();
  });
});
