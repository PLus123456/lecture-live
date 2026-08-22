import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 文档翻译的扣费豁免：管理员确认/重试翻译任务时既不扣钱包，台账 chargedCents 也记 0
 * （记非零会让后续失败退款把从没扣过的钱退进钱包）。
 * role 一律按 DB 行判 —— JWT 载荷里的 role 在降级后最长陈旧 7 天（改角色不 bump tokenVersion）。
 */

const {
  verifyAuthMock,
  userFindUniqueMock,
  taskFindUniqueMock,
  taskUpdateManyMock,
  txTaskUpdateManyMock,
  spendWalletCentsMock,
  getSiteSettingsMock,
  resolveUserFeatureFlagsMock,
  enqueueDocTranslateMock,
  refundTaskChargeMock,
  readSourceFileMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  taskFindUniqueMock: vi.fn(),
  taskUpdateManyMock: vi.fn(),
  txTaskUpdateManyMock: vi.fn(),
  spendWalletCentsMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  resolveUserFeatureFlagsMock: vi.fn(),
  enqueueDocTranslateMock: vi.fn(),
  refundTaskChargeMock: vi.fn(),
  readSourceFileMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/prisma', () => {
  const tx = { translationTask: { updateMany: txTaskUpdateManyMock } };
  return {
    prisma: {
      user: { findUnique: userFindUniqueMock },
      translationTask: {
        findUnique: taskFindUniqueMock,
        updateMany: taskUpdateManyMock,
      },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});
vi.mock('@/lib/wallet', () => ({
  spendWalletCents: spendWalletCentsMock,
  WalletError: class WalletError extends Error {
    constructor(
      message: string,
      readonly code?: string
    ) {
      super(message);
    }
  },
}));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/userRoles', () => ({
  resolveUserFeatureFlags: resolveUserFeatureFlagsMock,
}));
vi.mock('@/lib/translate/taskApi', () => ({
  TASK_VIEW_SELECT: {},
  toTaskView: (row: unknown) => row,
}));
vi.mock('@/lib/translate/taskStorage', () => ({ readSourceFile: readSourceFileMock }));
vi.mock('@/lib/translate/translateProcessor', () => ({
  enqueueDocTranslate: enqueueDocTranslateMock,
  refundTaskCharge: refundTaskChargeMock,
  runDocTranslateTick: vi.fn(),
}));

import { POST as CONFIRM } from '@/app/api/translate/documents/[id]/confirm/route';
import { POST as RETRY } from '@/app/api/translate/documents/[id]/retry/route';

const params = Promise.resolve({ id: 'task-1' });

function makeReq(path: string): Request {
  return new Request(`http://localhost:3000/api/translate/documents/task-1/${path}`, {
    method: 'POST',
  });
}

/** 事务里写进 chargedCents 的值（台账口径） */
function chargedCentsWritten(): number | undefined {
  const call = txTaskUpdateManyMock.mock.calls[0]?.[0] as
    | { data?: { chargedCents?: number } }
    | undefined;
  return call?.data?.chargedCents;
}

describe('文档翻译扣费：管理员豁免', () => {
  // 合并后 confirm/retry 用 updatedAt 做乐观 CAS，retry 还会核对 chargedCents /
  // refundedAt / jobQueueId / proxyGeneration。缺这些列会在 task.updatedAt.getTime()
  // 上直接 TypeError，整条用例变 500。
  const TASK_CAS_FIELDS = {
    updatedAt: new Date('2026-08-22T10:00:00.000Z'),
    chargedCents: 0,
    refundedAt: null,
    jobQueueId: null,
    proxyGeneration: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'admin-1', email: 'a@x.com', role: 'ADMIN' });
    getSiteSettingsMock.mockResolvedValue({ translation_doc_enabled: true });
    resolveUserFeatureFlagsMock.mockResolvedValue({ allowDocTranslation: true });
    userFindUniqueMock.mockResolvedValue({ role: 'ADMIN', customGroupId: null });
    taskFindUniqueMock.mockResolvedValue({
      id: 'task-1',
      userId: 'admin-1',
      status: 'QUOTED',
      estimatedCents: 1200,
      ...TASK_CAS_FIELDS,
    });
    txTaskUpdateManyMock.mockResolvedValue({ count: 1 });
    taskUpdateManyMock.mockResolvedValue({ count: 1 });
    spendWalletCentsMock.mockResolvedValue({ balanceAfterCents: 0 });
    enqueueDocTranslateMock.mockResolvedValue('job-1');
    readSourceFileMock.mockResolvedValue(Buffer.from('%PDF-1.4'));
  });

  it('confirm：管理员不扣钱包，chargedCents 记 0（即使报价行残留非零）', async () => {
    const res = await CONFIRM(makeReq('confirm'), { params });

    expect(res.status).toBe(200);
    expect(spendWalletCentsMock).not.toHaveBeenCalled();
    expect(chargedCentsWritten()).toBe(0);
    expect(enqueueDocTranslateMock).toHaveBeenCalledWith('task-1', 'admin-1');
  });

  it('confirm：普通用户照常扣费', async () => {
    verifyAuthMock.mockResolvedValue({ id: 'user-1', email: 'u@x.com', role: 'PRO' });
    userFindUniqueMock.mockResolvedValue({ role: 'PRO', customGroupId: null });
    taskFindUniqueMock.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      status: 'QUOTED',
      estimatedCents: 1200,
      ...TASK_CAS_FIELDS,
    });

    const res = await CONFIRM(makeReq('confirm'), { params });

    expect(res.status).toBe(200);
    expect(spendWalletCentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', amountCents: 1200, type: 'translation' }),
      expect.anything()
    );
    expect(chargedCentsWritten()).toBe(1200);
  });

  it('confirm：豁免只认 DB role —— JWT 说 ADMIN 但库里是 PRO → 照常扣费', async () => {
    userFindUniqueMock.mockResolvedValue({ role: 'PRO', customGroupId: null });

    const res = await CONFIRM(makeReq('confirm'), { params });

    expect(res.status).toBe(200);
    expect(spendWalletCentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 1200 }),
      expect.anything()
    );
  });

  it('retry：管理员重试同样不扣钱', async () => {
    taskFindUniqueMock.mockResolvedValue({
      id: 'task-1',
      userId: 'admin-1',
      status: 'FAILED',
      estimatedCents: 1200,
      ...TASK_CAS_FIELDS,
    });

    const res = await RETRY(makeReq('retry'), { params });

    expect(res.status).toBe(200);
    expect(spendWalletCentsMock).not.toHaveBeenCalled();
    expect(chargedCentsWritten()).toBe(0);
  });

  it('retry：普通用户重试照常再扣一次', async () => {
    verifyAuthMock.mockResolvedValue({ id: 'user-1', email: 'u@x.com', role: 'FREE' });
    userFindUniqueMock.mockResolvedValue({ role: 'FREE', customGroupId: null });
    taskFindUniqueMock.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      status: 'FAILED',
      estimatedCents: 1200,
      ...TASK_CAS_FIELDS,
    });

    const res = await RETRY(makeReq('retry'), { params });

    expect(res.status).toBe(200);
    expect(spendWalletCentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 1200, type: 'translation' }),
      expect.anything()
    );
  });

  it('组能力按 DB 行解析（不是 JWT 载荷）：自定义组 id 会被带进 resolveUserFeatureFlags', async () => {
    userFindUniqueMock.mockResolvedValue({ role: 'PRO', customGroupId: 'grp-7' });

    await CONFIRM(makeReq('confirm'), { params });

    expect(resolveUserFeatureFlagsMock).toHaveBeenCalledWith({
      role: 'PRO',
      customGroupId: 'grp-7',
    });
  });
});
