import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdminAccessMock,
  findManyMock,
  createMock,
  updateMock,
  transactionMock,
  writeSecurityAuditMock,
  trackJobMock,
  pingMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  findManyMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn(),
  transactionMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  trackJobMock: vi.fn(),
  pingMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
}));
vi.mock('@/lib/crypto', () => ({
  encrypt: (value: string) => `enc:${value}`,
  decrypt: (value: string) => value.replace(/^enc:/, ''),
}));
vi.mock('@/lib/storage/cloudreve', () => ({
  validateCloudreveBaseUrl: vi.fn(),
}));
vi.mock('@/lib/translate/workerClient', () => ({
  pingTranslateWorker: pingMock,
}));
vi.mock('@/lib/jobQueue', () => ({
  JOB_TYPE: { ADMIN_INTEGRATION: 'admin_integration' },
  trackJob: trackJobMock,
}));

const tx = {
  translationWorker: { create: createMock, update: updateMock },
  auditLog: { create: vi.fn() },
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    translationWorker: {
      findMany: findManyMock,
      create: createMock,
      update: updateMock,
    },
    $transaction: transactionMock,
  },
}));

import { GET, POST } from '@/app/api/admin/translate/workers/route';
import { POST as verify } from '@/app/api/admin/translate/workers/verify/route';

const WORKER = {
  id: 'worker-1',
  name: 'worker one',
  baseUrl: 'https://worker.example.test',
  token: `enc:${'x'.repeat(40)}`,
  enabled: true,
  concurrency: 2,
  weight: 1,
  qps: 4,
  status: 'UNVERIFIED',
  lastCheckedAt: null,
  lastError: null,
  sortOrder: 0,
  createdAt: new Date('2026-08-20T00:00:00Z'),
};

type TrackOptions = {
  resultSummary?: (value: unknown) => Record<string, unknown>;
  terminalMutation?: (
    value: typeof tx,
    terminal:
      | { status: 'SUCCESS'; result: unknown }
      | { status: 'FAILED'; error: unknown }
  ) => Promise<void>;
};

describe('translation worker admin security audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@example.test', role: 'ADMIN' },
      response: null,
    });
    findManyMock.mockResolvedValue([{ ...WORKER }]);
    createMock.mockImplementation(async ({ data }) => ({ ...WORKER, ...data }));
    updateMock.mockResolvedValue({ ...WORKER, status: 'OK' });
    writeSecurityAuditMock.mockResolvedValue(undefined);
    pingMock.mockResolvedValue({
      ok: true,
      version: '1.2.3',
      queue: { running: 0, queued: 0, capacity: 2, queueLimit: 4 },
      engine: { pdf2zh: '2.0' },
    });
    transactionMock.mockImplementation(
      async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)
    );
    trackJobMock.mockImplementation(
      async (options: TrackOptions, operation: () => Promise<unknown>) => {
        let result: unknown;
        try {
          result = await operation();
        } catch (error) {
          await options.terminalMutation?.(tx, { status: 'FAILED', error });
          throw error;
        }
        await options.terminalMutation?.(tx, { status: 'SUCCESS', result });
        return result;
      }
    );
  });

  it('worker 列表审计成功后才返回基础设施信息', async () => {
    const response = await GET(
      new Request('http://localhost/api/admin/translate/workers')
    );
    expect(response.status).toBe(200);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'translate-workers.read',
        outcome: 'SUCCESS',
        target: expect.objectContaining({ ids: ['worker-1'] }),
      })
    );
  });

  it('列表审计失败时不返回 worker 配置', async () => {
    writeSecurityAuditMock.mockRejectedValue(new Error('audit unavailable'));
    const response = await GET(
      new Request('http://localhost/api/admin/translate/workers')
    );
    expect(response.status).toBe(500);
  });

  it('创建 worker 与 SUCCESS audit 使用同一事务且不记录 token', async () => {
    const response = await POST(
      new Request('http://localhost/api/admin/translate/workers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'worker one',
          baseUrl: 'https://worker.example.test',
          token: 'x'.repeat(40),
        }),
      })
    );
    expect(response.status).toBe(200);
    const event = writeSecurityAuditMock.mock.calls[0][1];
    expect(event).toMatchObject({
      event: 'translate-workers.create',
      outcome: 'SUCCESS',
    });
    expect(JSON.stringify(event)).not.toContain('x'.repeat(40));
    expect(writeSecurityAuditMock.mock.calls[0][2]).toBe(tx);
  });

  it('verify 先走 durable job，再把状态更新与结果审计放进终态事务', async () => {
    const response = await verify(
      new Request('http://localhost/api/admin/translate/workers/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'worker-1' }),
      })
    );
    expect(response.status).toBe(200);
    expect(trackJobMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'worker-1' },
        data: expect.objectContaining({ status: 'OK' }),
      })
    );
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'translate-workers.verify',
        outcome: 'SUCCESS',
      }),
      tx
    );
    const options = trackJobMock.mock.calls[0][0] as TrackOptions;
    expect(JSON.stringify(options.resultSummary?.({
      publicResults: [{ ok: true }],
      statusUpdates: [{ id: 'worker-1', data: { lastError: 'secret body' } }],
    }))).not.toContain('secret body');
  });

  it('verify 终态审计失败时不确认探测成功', async () => {
    writeSecurityAuditMock.mockRejectedValue(new Error('audit unavailable'));
    const response = await verify(
      new Request('http://localhost/api/admin/translate/workers/verify', {
        method: 'POST',
        body: '{}',
      })
    );
    expect(response.status).toBe(500);
  });
});
