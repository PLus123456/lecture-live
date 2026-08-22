import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAdminAccessMock,
  providerFindUniqueMock,
  modelFindFirstMock,
  modelUpdateManyMock,
  modelCreateMock,
  modelUpdateMock,
  modelDeleteMock,
  writeSecurityAuditMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  providerFindUniqueMock: vi.fn(),
  modelFindFirstMock: vi.fn(),
  modelUpdateManyMock: vi.fn(),
  modelCreateMock: vi.fn(),
  modelUpdateMock: vi.fn(),
  modelDeleteMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({ requireAdminAccess: requireAdminAccessMock }));
vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
}));

vi.mock('@/lib/prisma', () => {
  const txClient = {
    llmModel: {
      findFirst: modelFindFirstMock,
      updateMany: modelUpdateManyMock,
      create: modelCreateMock,
      update: modelUpdateMock,
      delete: modelDeleteMock,
    },
    auditLog: { create: vi.fn() },
  };
  return { prisma: {
    llmProvider: { findUnique: providerFindUniqueMock },
    llmModel: txClient.llmModel,
    $transaction: async (fn: (value: typeof txClient) => Promise<unknown>) =>
      fn(txClient),
  } };
});

import { POST } from '@/app/api/admin/llm-providers/[id]/models/route';
import {
  PATCH,
  DELETE,
} from '@/app/api/admin/llm-providers/[id]/models/[modelId]/route';

const MODEL = {
  id: 'model-row-1',
  providerId: 'prov-1',
  modelId: 'gpt-x',
  displayName: 'GPT X',
  thinkingDepth: 'medium',
  thinkingMode: 'NONE',
  supportsThinkingDepth: false,
  supportsImage: false,
  maxTokens: 4096,
  contextWindow: 8192,
  temperature: 0.3,
  purpose: 'CHAT',
  isDefault: false,
  sortOrder: 0,
};

const providerParams = { params: Promise.resolve({ id: 'prov-1' }) };
const modelParams = {
  params: Promise.resolve({ id: 'prov-1', modelId: 'model-row-1' }),
};

function jsonRequest(method: string, body: unknown) {
  return new Request('http://localhost/api/admin/llm-providers/prov-1/models', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('LLM legacy model CRUD security audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@example.test', role: 'ADMIN' },
      response: null,
    });
    providerFindUniqueMock.mockResolvedValue({ id: 'prov-1' });
    modelFindFirstMock.mockResolvedValue({ ...MODEL });
    modelUpdateManyMock.mockResolvedValue({ count: 0 });
    modelCreateMock.mockImplementation(async ({ data }) => ({ ...MODEL, ...data }));
    modelUpdateMock.mockImplementation(async ({ data }) => ({ ...MODEL, ...data }));
    modelDeleteMock.mockResolvedValue({ ...MODEL });
    writeSecurityAuditMock.mockResolvedValue(undefined);
  });

  it('create 的默认互斥、行写入与 SUCCESS audit 同事务', async () => {
    const response = await POST(
      jsonRequest('POST', {
        modelId: 'gpt-x',
        displayName: 'GPT X',
        isDefault: true,
      }),
      providerParams
    );
    expect(response.status).toBe(201);
    expect(modelUpdateManyMock).toHaveBeenCalled();
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ event: 'llm-models.create', outcome: 'SUCCESS' }),
      expect.any(Object)
    );
  });

  it('PATCH 记录 allowlisted before/after，不写凭据', async () => {
    const response = await PATCH(
      jsonRequest('PATCH', { thinkingMode: 'DEPTH' }),
      modelParams
    );
    expect(response.status).toBe(200);
    const event = writeSecurityAuditMock.mock.calls[0][1];
    expect(event).toMatchObject({ event: 'llm-models.update', outcome: 'SUCCESS' });
    expect(event.before).not.toHaveProperty('apiKey');
    expect(event.after).not.toHaveProperty('apiKey');
  });

  it('DELETE 与删除结果 audit 同事务', async () => {
    const response = await DELETE(
      new Request('http://localhost/api/admin/llm-providers/prov-1/models/model-row-1', {
        method: 'DELETE',
      }),
      modelParams
    );
    expect(response.status).toBe(200);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ event: 'llm-models.delete', outcome: 'SUCCESS' }),
      expect.any(Object)
    );
  });

  it('审计失败时不确认模型写入成功', async () => {
    writeSecurityAuditMock.mockRejectedValue(new Error('audit unavailable'));
    const response = await PATCH(
      jsonRequest('PATCH', { temperature: 0.5 }),
      modelParams
    );
    expect(response.status).toBe(500);
  });
});
