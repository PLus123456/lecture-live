import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUniqueMock, getRedisClientMock, sendQuotaAlertEmailMock, redisSetMock, redisDelMock } =
  vi.hoisted(() => ({
    findUniqueMock: vi.fn(),
    getRedisClientMock: vi.fn(),
    sendQuotaAlertEmailMock: vi.fn(),
    redisSetMock: vi.fn(),
    redisDelMock: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: findUniqueMock } },
}));

vi.mock('@/lib/redis', () => ({
  getRedisClient: getRedisClientMock,
}));

vi.mock('@/lib/email', () => ({
  sendQuotaAlertEmail: sendQuotaAlertEmailMock,
}));

import { maybeSendTranscriptionQuotaAlert } from '@/lib/email/quotaAlert';

const BASE_USER = {
  id: 'u1',
  email: 'u@example.com',
  displayName: '用户',
  emailPreferences: null,
  role: 'FREE',
  status: 1,
  transcriptionMinutesUsed: 54,
  transcriptionMinutesLimit: 60,
  purchasedMinutesBalance: 0,
  quotaResetAt: new Date('2026-08-01T00:00:00Z'),
};

describe('maybeSendTranscriptionQuotaAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisSetMock.mockResolvedValue('OK');
    redisDelMock.mockResolvedValue(1);
    getRedisClientMock.mockReturnValue({
      status: 'ready',
      set: redisSetMock,
      del: redisDelMock,
    });
    sendQuotaAlertEmailMock.mockResolvedValue({ ok: true });
    findUniqueMock.mockResolvedValue(BASE_USER);
  });

  it('无时长池时 54/60 = 90% → 发提醒', async () => {
    await maybeSendTranscriptionQuotaAlert('u1');

    expect(sendQuotaAlertEmailMock).toHaveBeenCalledTimes(1);
    expect(sendQuotaAlertEmailMock.mock.calls[0][1]).toMatchObject({
      usedLabel: '54 / 60 分钟',
      percentLabel: '90%',
    });
  });

  // 核心回归：分母漏掉永久时长池，会让刚买了时长包的用户被误报"快用完"。
  it('持有时长池时分母含池子 → 54/(60+1000) 远未到阈值，不发信', async () => {
    findUniqueMock.mockResolvedValue({ ...BASE_USER, purchasedMinutesBalance: 1000 });

    await maybeSendTranscriptionQuotaAlert('u1');

    expect(sendQuotaAlertEmailMock).not.toHaveBeenCalled();
    // 连去重键都不该抢——否则真到 90% 时反而发不出来了
    expect(redisSetMock).not.toHaveBeenCalled();
  });

  it('用量确实逼近「上限+池子」时仍会发，且标签显示合并后的分母', async () => {
    findUniqueMock.mockResolvedValue({
      ...BASE_USER,
      transcriptionMinutesUsed: 960,
      purchasedMinutesBalance: 1000,
    });

    await maybeSendTranscriptionQuotaAlert('u1');

    expect(sendQuotaAlertEmailMock).toHaveBeenCalledTimes(1);
    expect(sendQuotaAlertEmailMock.mock.calls[0][1]).toMatchObject({
      usedLabel: '960 / 1060 分钟',
      percentLabel: '91%',
    });
  });

  // Model A 允许 used 超过 limit（超出部分是本周期动用的池子）。
  it('used 超过月度上限但池子仍充足时不误报', async () => {
    findUniqueMock.mockResolvedValue({
      ...BASE_USER,
      transcriptionMinutesUsed: 300, // 已超 limit=60
      purchasedMinutesBalance: 1000,
    });

    await maybeSendTranscriptionQuotaAlert('u1');

    expect(sendQuotaAlertEmailMock).not.toHaveBeenCalled();
  });

  it('发送失败时释放去重键，留待下次重试', async () => {
    sendQuotaAlertEmailMock.mockResolvedValue({ ok: false, error: 'SMTP 连接失败' });

    await maybeSendTranscriptionQuotaAlert('u1');

    expect(redisSetMock).toHaveBeenCalledTimes(1);
    expect(redisDelMock).toHaveBeenCalledWith('email:quota-alerted:u1:2026-08-01');
  });

  it('发送成功时保留去重键（本周期不再重复打扰）', async () => {
    await maybeSendTranscriptionQuotaAlert('u1');

    expect(redisDelMock).not.toHaveBeenCalled();
  });

  it('用户主动关闭该分类（skipped:preference）时保留去重键，不当作失败重试', async () => {
    sendQuotaAlertEmailMock.mockResolvedValue({ ok: true, error: 'skipped:preference' });

    await maybeSendTranscriptionQuotaAlert('u1');

    expect(redisDelMock).not.toHaveBeenCalled();
  });

  it('已抢过去重键（本周期发过）→ 直接跳过', async () => {
    redisSetMock.mockResolvedValue(null);

    await maybeSendTranscriptionQuotaAlert('u1');

    expect(sendQuotaAlertEmailMock).not.toHaveBeenCalled();
  });

  it('封禁账号不打扰', async () => {
    findUniqueMock.mockResolvedValue({ ...BASE_USER, status: 0 });

    await maybeSendTranscriptionQuotaAlert('u1');

    expect(sendQuotaAlertEmailMock).not.toHaveBeenCalled();
  });

  it('ADMIN（无限配额）跳过', async () => {
    findUniqueMock.mockResolvedValue({ ...BASE_USER, role: 'ADMIN' });

    await maybeSendTranscriptionQuotaAlert('u1');

    expect(sendQuotaAlertEmailMock).not.toHaveBeenCalled();
  });

  it('无 Redis 时跳过（无法按周期去重，宁可不发也不轰炸）', async () => {
    getRedisClientMock.mockReturnValue(null);

    await maybeSendTranscriptionQuotaAlert('u1');

    expect(sendQuotaAlertEmailMock).not.toHaveBeenCalled();
  });

  it('异常一律吞掉，不影响会话收尾主流程', async () => {
    findUniqueMock.mockRejectedValue(new Error('DB 挂了'));

    await expect(maybeSendTranscriptionQuotaAlert('u1')).resolves.toBeUndefined();
  });
});
