import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthMock,
  getSiteSettingsMock,
  resolveUserFeatureFlagsMock,
  taskFindUniqueMock,
  userFindUniqueMock,
  taskUpdateManyMock,
  transactionMock,
  txTaskUpdateManyMock,
  readSourceFileMock,
  enqueueDocTranslateMock,
  refundTaskChargeMock,
  runDocTranslateTickMock,
  spendWalletCentsMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  resolveUserFeatureFlagsMock: vi.fn(),
  taskFindUniqueMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  taskUpdateManyMock: vi.fn(),
  transactionMock: vi.fn(),
  txTaskUpdateManyMock: vi.fn(),
  readSourceFileMock: vi.fn(),
  enqueueDocTranslateMock: vi.fn(),
  refundTaskChargeMock: vi.fn(),
  runDocTranslateTickMock: vi.fn(),
  spendWalletCentsMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/userRoles', () => ({
  resolveUserFeatureFlags: resolveUserFeatureFlagsMock,
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    // #232/#233 之后路由以 DB 行判角色与组，prisma mock 缺 user 键会直接 TypeError。
    user: { findUnique: userFindUniqueMock },
    translationTask: {
      findUnique: taskFindUniqueMock,
      updateMany: taskUpdateManyMock,
    },
    $transaction: transactionMock,
  },
}));
vi.mock('@/lib/wallet', () => ({
  spendWalletCents: spendWalletCentsMock,
  WalletError: class WalletError extends Error {
    constructor(
      message: string,
      readonly code: string
    ) {
      super(message);
    }
  },
}));
vi.mock('@/lib/translate/taskApi', () => ({
  TASK_VIEW_SELECT: {},
  toTaskView: (value: unknown) => value,
}));
vi.mock('@/lib/translate/taskStorage', () => ({
  readSourceFile: readSourceFileMock,
}));
vi.mock('@/lib/translate/translateProcessor', () => ({
  enqueueDocTranslate: enqueueDocTranslateMock,
  refundTaskCharge: refundTaskChargeMock,
  runDocTranslateTick: runDocTranslateTickMock,
}));

import { POST } from '../route';

function request() {
  return POST(
    new Request('http://localhost/api/translate/documents/task-1/retry', {
      method: 'POST',
    }),
    { params: Promise.resolve({ id: 'task-1' }) }
  );
}

describe('translation retry generation/refund admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1' });
    userFindUniqueMock.mockResolvedValue({
      id: 'user-1',
      role: 'PRO',
      customGroupId: null,
    });
    getSiteSettingsMock.mockResolvedValue({ translation_doc_enabled: true });
    resolveUserFeatureFlagsMock.mockResolvedValue({
      allowDocTranslation: true,
    });
    readSourceFileMock.mockResolvedValue(Buffer.from('pdf'));
    txTaskUpdateManyMock.mockResolvedValue({ count: 1 });
    taskUpdateManyMock.mockResolvedValue({ count: 1 });
    enqueueDocTranslateMock.mockResolvedValue('job-2');
    refundTaskChargeMock.mockResolvedValue({
      claimed: true,
      updatedAt: new Date('2026-08-20T12:00:00.001Z'),
    });
    transactionMock.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          translationTask: { updateMany: txTaskUpdateManyMock },
        })
    );
  });

  it('旧快照补退款已输给后续生命周期时拒绝接管新终态', async () => {
    taskFindUniqueMock.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      status: 'CANCELED',
      estimatedCents: 100,
      chargedCents: 100,
      refundedAt: null,
      jobQueueId: null,
      proxyGeneration: null,
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    });
    refundTaskChargeMock.mockResolvedValue({ claimed: false });

    const response = await request();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'refund_pending',
    });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(enqueueDocTranslateMock).not.toHaveBeenCalled();
    expect(refundTaskChargeMock).toHaveBeenCalledWith(
      'task-1',
      '重试前补退款',
      {
        status: 'CANCELED',
        jobQueueId: null,
        proxyGeneration: null,
        chargedCents: 100,
        updatedAt: new Date('2026-08-20T12:00:00.000Z'),
      }
    );
  });

  it('已退款任务只在事务 CAS 仍满足退款闸时复位，并清旧 worker 绑定', async () => {
    taskFindUniqueMock
      .mockResolvedValueOnce({
        id: 'task-1',
        userId: 'user-1',
        status: 'FAILED',
        estimatedCents: 100,
        chargedCents: 100,
        refundedAt: new Date('2026-08-20T00:00:00Z'),
        jobQueueId: 'job-1',
        proxyGeneration: null,
        updatedAt: new Date('2026-08-20T12:00:00.000Z'),
      })
      .mockResolvedValueOnce({ id: 'task-1', status: 'PENDING' });

    const response = await request();

    expect(response.status).toBe(200);
    expect(txTaskUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'task-1',
          OR: [
            { chargedCents: { lte: 0 } },
            { refundedAt: { not: null } },
          ],
        }),
        data: expect.objectContaining({
          jobQueueId: null,
          proxyGeneration: null,
          proxyTokenHash: null,
          workerId: null,
        }),
      })
    );
    expect(enqueueDocTranslateMock).toHaveBeenCalledWith('task-1', 'user-1');
  });

  it('enqueue 结果未知且任务已绑定新代时返回409，不误标FAILED或退款', async () => {
    taskFindUniqueMock.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      status: 'FAILED',
      estimatedCents: 0,
      chargedCents: 0,
      refundedAt: null,
      jobQueueId: 'job-1',
      proxyGeneration: null,
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    });
    enqueueDocTranslateMock.mockResolvedValue(null);
    taskUpdateManyMock.mockResolvedValue({ count: 0 });

    const response = await request();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'task_generation_changed',
    });
    expect(taskUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          jobQueueId: null,
          proxyGeneration: null,
        }),
      })
    );
    expect(refundTaskChargeMock).not.toHaveBeenCalled();
  });

  it('重试入队失败退款绑定刚写入的终态快照', async () => {
    taskFindUniqueMock.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      status: 'FAILED',
      estimatedCents: 90,
      chargedCents: 90,
      refundedAt: new Date('2026-08-20T00:00:00Z'),
      jobQueueId: 'job-old',
      proxyGeneration: null,
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    });
    enqueueDocTranslateMock.mockResolvedValue(null);
    taskUpdateManyMock.mockResolvedValue({ count: 1 });

    const response = await request();

    expect(response.status).toBe(500);
    expect(refundTaskChargeMock).toHaveBeenCalledWith(
      'task-1',
      '入队失败退款',
      {
        status: 'FAILED',
        jobQueueId: null,
        proxyGeneration: null,
        chargedCents: 90,
        updatedAt: expect.any(Date),
      }
    );
  });

  it('零元重试入队失败不要求退款 winner', async () => {
    taskFindUniqueMock.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      status: 'FAILED',
      estimatedCents: 0,
      chargedCents: 0,
      refundedAt: null,
      jobQueueId: 'job-old',
      proxyGeneration: null,
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    });
    enqueueDocTranslateMock.mockResolvedValue(null);
    taskUpdateManyMock.mockResolvedValue({ count: 1 });

    const response = await request();

    expect(response.status).toBe(500);
    expect(refundTaskChargeMock).not.toHaveBeenCalled();
  });
});
