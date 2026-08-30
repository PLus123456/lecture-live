import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdminAccessMock,
  registryFindFirstMock,
  registryUpdateMock,
  registryDeleteMock,
  syncRegistrySpecMock,
  verifyRegistryModelMock,
  writeSecurityAuditMock,
  trackJobMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  registryFindFirstMock: vi.fn(),
  registryUpdateMock: vi.fn(),
  registryDeleteMock: vi.fn(),
  syncRegistrySpecMock: vi.fn(),
  verifyRegistryModelMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
  trackJobMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
}));
vi.mock('@/lib/llm/registry', () => ({
  coerceRegistryKind: (value: unknown) => (value === 'EMBEDDING' ? 'EMBEDDING' : 'TEXT'),
  syncRegistrySpecToRoutes: syncRegistrySpecMock,
}));
vi.mock('@/lib/llm/verifyModel', () => ({
  verifyRegistryModel: verifyRegistryModelMock,
}));
vi.mock('@/lib/jobQueue', () => ({
  JOB_TYPE: { ADMIN_INTEGRATION: 'admin_integration' },
  trackJob: trackJobMock,
}));

const tx = {
  llmRegistryModel: { update: registryUpdateMock, delete: registryDeleteMock },
  auditLog: { create: vi.fn() },
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    llmRegistryModel: {
      findFirst: registryFindFirstMock,
      update: registryUpdateMock,
      delete: registryDeleteMock,
    },
    $transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
  },
}));

import {
  PATCH,
  DELETE,
} from '@/app/api/admin/llm-providers/[id]/registry/[registryId]/route';
import { POST as verify } from '@/app/api/admin/llm-providers/[id]/registry/[registryId]/verify/route';

const REGISTRY = {
  id: 'reg-1',
  providerId: 'prov-1',
  modelId: 'gpt-x',
  displayName: 'GPT X',
  kind: 'TEXT',
  supportsImage: false,
  maxTokens: 4096,
  contextWindow: 8192,
  embeddingDimensions: null,
  sortOrder: 0,
  status: 'UNVERIFIED',
  lastCheckedAt: null,
  lastError: null,
  routes: [],
  provider: {
    apiBase: 'https://api.example.test/v1',
    apiKey: 'enc:key',
    isAnthropic: false,
  },
};

const params = {
  params: Promise.resolve({ id: 'prov-1', registryId: 'reg-1' }),
};

type TrackOptions = {
  terminalMutation?: (
    value: typeof tx,
    terminal:
      | { status: 'SUCCESS'; result: unknown }
      | { status: 'FAILED'; error: unknown }
  ) => Promise<void>;
};

describe('LLM registry update/delete/verify security audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@example.test', role: 'ADMIN' },
      response: null,
    });
    registryFindFirstMock.mockImplementation(async ({ where }) =>
      where?.id?.not ? null : { ...REGISTRY }
    );
    registryUpdateMock.mockImplementation(async ({ data }) => ({
      ...REGISTRY,
      ...data,
      routes: [],
    }));
    registryDeleteMock.mockResolvedValue({ ...REGISTRY });
    syncRegistrySpecMock.mockResolvedValue(undefined);
    verifyRegistryModelMock.mockResolvedValue({ ok: true, error: null });
    writeSecurityAuditMock.mockResolvedValue(undefined);
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

  it('规格更新、路由写穿和 SUCCESS audit 同事务', async () => {
    const response = await PATCH(
      new Request('http://localhost/registry/reg-1', {
        method: 'PATCH',
        body: JSON.stringify({ maxTokens: 2048 }),
      }),
      params
    );
    expect(response.status).toBe(200);
    expect(syncRegistrySpecMock).toHaveBeenCalledWith(
      'reg-1',
      expect.objectContaining({ maxTokens: 2048 }),
      tx
    );
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ event: 'llm-registry.update', outcome: 'SUCCESS' }),
      tx
    );
  });

  it('删除 registry 与审计同事务', async () => {
    const response = await DELETE(
      new Request('http://localhost/registry/reg-1', { method: 'DELETE' }),
      params
    );
    expect(response.status).toBe(200);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ event: 'llm-registry.delete', outcome: 'SUCCESS' }),
      tx
    );
  });

  it('外部 verify 通过 durable job，状态写入与审计在终态事务', async () => {
    const response = await verify(
      new Request('http://localhost/registry/reg-1/verify', { method: 'POST' }),
      params
    );
    expect(response.status).toBe(200);
    expect(trackJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'admin_integration',
        params: expect.objectContaining({ operation: 'llm_registry_verify' }),
      }),
      expect.any(Function)
    );
    expect(registryUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'OK' }) })
    );
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ event: 'llm-registry.verify', outcome: 'SUCCESS' }),
      tx
    );
  });

  it('verify 审计失败时不确认探测成功', async () => {
    writeSecurityAuditMock.mockRejectedValue(new Error('audit unavailable'));
    const response = await verify(
      new Request('http://localhost/registry/reg-1/verify', { method: 'POST' }),
      params
    );
    expect(response.status).toBe(500);
  });
});
