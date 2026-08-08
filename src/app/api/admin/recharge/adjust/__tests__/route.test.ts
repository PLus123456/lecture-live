import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../../tests/utils/http';

const {
  requireAdminAccessMock,
  adminAdjustMock,
  getWalletSummaryMock,
  userFindUniqueMock,
  logActionMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  adminAdjustMock: vi.fn(),
  getWalletSummaryMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  logActionMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/auditLog', () => ({ logAction: logActionMock }));
vi.mock('@/lib/requestLogger', () => ({
  withRequestLogging: (_s: string, handler: (req: Request) => Promise<Response>) => handler,
}));
vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: userFindUniqueMock } },
}));
vi.mock('@/lib/wallet', () => ({
  adminAdjust: adminAdjustMock,
  getWalletSummary: getWalletSummaryMock,
  WalletError: class WalletError extends Error {},
}));

import { POST } from '@/app/api/admin/recharge/adjust/route';

/** withRequestLogging 包出来的 handler 形参是 (req, context)；路由本身不读 context。 */
const CTX = { params: Promise.resolve({}) } as never;

beforeEach(() => {
  requireAdminAccessMock.mockReset();
  adminAdjustMock.mockReset();
  getWalletSummaryMock.mockReset();
  logActionMock.mockReset();
  requireAdminAccessMock.mockResolvedValue({
    user: { id: 'admin-1', email: 'a@b.c', role: 'ADMIN' },
    response: null,
  });
  getWalletSummaryMock.mockResolvedValue({ walletBalanceCents: 0 });
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
