import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthMock,
  getSiteSettingsMock,
  resolveUserFeatureFlagsMock,
  taskFindUniqueMock,
  taskUpdateManyMock,
  txTaskUpdateManyMock,
  userFindUniqueMock,
  transactionMock,
  enqueueDocTranslateMock,
  refundTaskChargeMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  resolveUserFeatureFlagsMock: vi.fn(),
  taskFindUniqueMock: vi.fn(),
  taskUpdateManyMock: vi.fn(),
  txTaskUpdateManyMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
  enqueueDocTranslateMock: vi.fn(),
  refundTaskChargeMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/userRoles', () => ({
  resolveUserFeatureFlags: resolveUserFeatureFlagsMock,
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    translationTask: {
      findUnique: taskFindUniqueMock,
      updateMany: taskUpdateManyMock,
    },
    user: { findUnique: userFindUniqueMock },
    $transaction: transactionMock,
  },
}));
vi.mock('@/lib/wallet', () => ({
  spendWalletCents: vi.fn(),
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
vi.mock('@/lib/translate/translateProcessor', () => ({
  enqueueDocTranslate: enqueueDocTranslateMock,
  refundTaskCharge: refundTaskChargeMock,
  runDocTranslateTick: vi.fn(),
}));

import { POST } from '../route';

describe('translation confirm enqueue generation guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1' });
    // #232/#233 之后路由以 DB 行判角色（豁免/门禁都不看 JWT 载荷）；
    // 不配置这个桩会让每条用例都在「用户不存在」上 404。
    userFindUniqueMock.mockResolvedValue({
      id: 'user-1',
      role: 'PRO',
      customGroupId: null,
    });
    getSiteSettingsMock.mockResolvedValue({ translation_doc_enabled: true });
    resolveUserFeatureFlagsMock.mockResolvedValue({
      allowDocTranslation: true,
    });
    taskFindUniqueMock.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      status: 'QUOTED',
      estimatedCents: 0,
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    });
    txTaskUpdateManyMock.mockResolvedValue({ count: 1 });
    transactionMock.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          translationTask: { updateMany: txTaskUpdateManyMock },
        })
    );
    enqueueDocTranslateMock.mockResolvedValue(null);
    taskUpdateManyMock.mockResolvedValue({ count: 0 });
    refundTaskChargeMock.mockResolvedValue({
      claimed: true,
      updatedAt: new Date('2026-08-20T12:00:00.002Z'),
    });
  });

  it('bind 提交状态未知且已有 generation 时不误标失败或退款', async () => {
    const response = await POST(
      new Request('http://localhost/api/translate/documents/task-1/confirm', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'task_generation_changed',
    });
    expect(taskUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'PENDING',
          jobQueueId: null,
          proxyGeneration: null,
        }),
      })
    );
    expect(refundTaskChargeMock).not.toHaveBeenCalled();
  });

  it('入队失败退款绑定刚写入的终态快照', async () => {
    taskFindUniqueMock.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      status: 'QUOTED',
      estimatedCents: 90,
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    });
    taskUpdateManyMock.mockResolvedValue({ count: 1 });

    const response = await POST(
      new Request('http://localhost/api/translate/documents/task-1/confirm', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );

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

  it('零元任务入队失败直接进入可重试终态，不伪报退款竞态', async () => {
    taskUpdateManyMock.mockResolvedValue({ count: 1 });

    const response = await POST(
      new Request('http://localhost/api/translate/documents/task-1/confirm', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );

    expect(response.status).toBe(500);
    expect(refundTaskChargeMock).not.toHaveBeenCalled();
  });
});
