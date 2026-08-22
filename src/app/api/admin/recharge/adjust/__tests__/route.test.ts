import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  adminAdjustMock,
  getWalletSummaryMock,
  userFindUniqueMock,
  logActionMock,
  writeSecurityAuditMock,
  getSecurityAuditRequestIdMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  adminAdjustMock: vi.fn(),
  getWalletSummaryMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  logActionMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  getSecurityAuditRequestIdMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/auditLog', () => ({ logAction: logActionMock }));
vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
  getSecurityAuditRequestId: getSecurityAuditRequestIdMock,
}));
vi.mock('@/lib/requestLogger', () => ({
  withRequestLogging: (_s: string, handler: (req: Request) => Promise<Response>) => handler,
}));
vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: userFindUniqueMock } },
}));
vi.mock('@/lib/wallet', () => ({
  adminAdjust: adminAdjustMock,
  getWalletSummary: getWalletSummaryMock,
  WalletError: class WalletError extends Error {
    constructor(
      message: string,
      readonly code: string
    ) {
      super(message);
      this.name = 'WalletError';
    }
  },
}));

import { POST } from '@/app/api/admin/recharge/adjust/route';
import { WalletError } from '@/lib/wallet';

/** withRequestLogging 包出来的 handler 形参是 (req, context)；路由本身不读 context。 */
const CTX = { params: Promise.resolve({}) } as never;

beforeEach(() => {
  requireAdminAccessMock.mockReset();
  adminAdjustMock.mockReset();
  getWalletSummaryMock.mockReset();
  logActionMock.mockReset();
  writeSecurityAuditMock.mockReset();
  getSecurityAuditRequestIdMock.mockReset();
  requireAdminAccessMock.mockResolvedValue({
    user: { id: 'admin-1', email: 'a@b.c', role: 'ADMIN' },
    response: null,
  });
  getWalletSummaryMock.mockResolvedValue({
    walletBalanceCents: 0,
    purchasedMinutesBalance: 0,
    role: 'FREE',
    roleExpiresAt: null,
  });
  writeSecurityAuditMock.mockResolvedValue({ requestId: 'req-1', action: 'audit' });
  getSecurityAuditRequestIdMock.mockReturnValue('req-1');
});

const post = (body: unknown) =>
  POST(
    createJsonRequest('http://localhost/api/admin/recharge/adjust', {
      method: 'POST',
      body,
    }),
    CTX
  );

describe('SEC-033：管理员钱包调整安全审计', () => {
  it('以同一 requestId 记录目标、前后快照、实际调整与截断结果', async () => {
    getWalletSummaryMock
      .mockResolvedValueOnce({
        walletBalanceCents: 500,
        purchasedMinutesBalance: 20,
        role: 'FREE',
        roleExpiresAt: null,
      })
      .mockResolvedValueOnce({
        walletBalanceCents: 200,
        purchasedMinutesBalance: 15,
        role: 'FREE',
        roleExpiresAt: null,
      });
    adminAdjustMock.mockResolvedValue({ amountCentsDelta: -300, minutesDelta: -5 });

    const res = await post({
      userId: 'u1',
      amountCentsDelta: -999,
      minutesDelta: -999,
      note: 'support case details must not enter security audit',
    });

    expect(res.status).toBe(200);
    expect(writeSecurityAuditMock).toHaveBeenCalledTimes(2);
    expect(writeSecurityAuditMock.mock.calls[0][1]).toMatchObject({
      event: 'recharge.adjust',
      operator: { id: 'admin-1', email: 'a@b.c', role: 'ADMIN' },
      target: { type: 'user_wallet', id: 'u1', ownerId: 'u1' },
      before: { walletBalanceCents: 500, purchasedMinutesBalance: 20 },
      after: { requested: { amountCentsDelta: -999, minutesDelta: -999 } },
      reason: 'admin_adjust',
      outcome: 'ATTEMPTED',
      requestId: 'req-1',
    });
    expect(writeSecurityAuditMock.mock.calls[1][1]).toMatchObject({
      before: { walletBalanceCents: 500, purchasedMinutesBalance: 20 },
      after: {
        wallet: { walletBalanceCents: 200, purchasedMinutesBalance: 15 },
        effective: { amountCentsDelta: -300, minutesDelta: -5 },
      },
      outcome: 'SUCCESS',
      metadata: {
        requested: { amountCentsDelta: -999, minutesDelta: -999 },
        noteProvided: true,
        truncated: true,
      },
      requestId: 'req-1',
    });
    expect(JSON.stringify(writeSecurityAuditMock.mock.calls.map((call) => call[1]))).not.toContain(
      'support case details'
    );
  });

  it('ATTEMPTED 审计失败时返回 503 且不调用钱包 mutation', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await post({ userId: 'u1', amountCentsDelta: 100 });

    expect(res.status).toBe(503);
    expect(adminAdjustMock).not.toHaveBeenCalled();
  });

  it('钱包业务拒绝时写 FAILED 后保留原有 400 语义', async () => {
    adminAdjustMock.mockRejectedValueOnce(new WalletError('用户不存在', 'user_not_found'));

    const res = await post({ userId: 'u1', amountCentsDelta: 100 });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '用户不存在', code: 'user_not_found' });
    expect(writeSecurityAuditMock.mock.calls.map((call) => call[1].outcome)).toEqual([
      'ATTEMPTED',
      'FAILED',
    ]);
  });

  it('SUCCESS 完成审计失败时返回 503 且不返回余额 payload', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    adminAdjustMock.mockResolvedValue({ amountCentsDelta: 100, minutesDelta: 0 });
    getWalletSummaryMock
      .mockResolvedValueOnce({
        walletBalanceCents: 0,
        purchasedMinutesBalance: 0,
        role: 'FREE',
        roleExpiresAt: null,
      })
      .mockResolvedValueOnce({
        walletBalanceCents: 100,
        purchasedMinutesBalance: 0,
        role: 'FREE',
        roleExpiresAt: null,
      });
    writeSecurityAuditMock
      .mockResolvedValueOnce({ requestId: 'req-1', action: 'attempt' })
      .mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await post({ userId: 'u1', amountCentsDelta: 100 });
    const body = await res.text();

    expect(res.status).toBe(503);
    expect(adminAdjustMock).toHaveBeenCalled();
    expect(body).not.toContain('walletBalanceCents');
  });
});

// P3-18：调整会按余额/池余额截断。日志记请求值、台账记截断值 —— 事后没人分得清哪个是真的。
describe('/api/admin/recharge/adjust 审计日志', () => {
  it('▶ 记实际生效值而非请求值，并标注被截断', async () => {
    adminAdjustMock.mockResolvedValue({ amountCentsDelta: -300, minutesDelta: -5 });

    await POST(
      createJsonRequest('http://localhost/api/admin/recharge/adjust', {
        method: 'POST',
        body: { userId: 'u1', amountCentsDelta: -100000, minutesDelta: -999 },
      }),
      CTX
    );

    const detail = logActionMock.mock.calls[0][2].detail as string;
    expect(detail).toContain('余额-300分');
    expect(detail).toContain('时长-5分钟');
    expect(detail).toContain('已按余额截断');
  });

  it('▶ 未被截断时不加噪音后缀', async () => {
    adminAdjustMock.mockResolvedValue({ amountCentsDelta: 1000, minutesDelta: 0 });

    await POST(
      createJsonRequest('http://localhost/api/admin/recharge/adjust', {
        method: 'POST',
        body: { userId: 'u1', amountCentsDelta: 1000 },
      }),
      CTX
    );

    const detail = logActionMock.mock.calls[0][2].detail as string;
    expect(detail).toContain('余额1000分');
    expect(detail).not.toContain('已按余额截断');
  });
});
