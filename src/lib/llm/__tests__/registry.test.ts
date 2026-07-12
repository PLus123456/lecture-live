import { beforeEach, describe, expect, it, vi } from 'vitest';

// ensureLlmRegistry：历史路由行 → 模型库条目的幂等归并迁移

const {
  llmModelFindManyMock,
  llmModelUpdateManyMock,
  registryFindFirstMock,
  registryCreateMock,
} = vi.hoisted(() => ({
  llmModelFindManyMock: vi.fn(),
  llmModelUpdateManyMock: vi.fn(),
  registryFindFirstMock: vi.fn(),
  registryCreateMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const tx = {
    llmModel: {
      findMany: llmModelFindManyMock,
      updateMany: llmModelUpdateManyMock,
    },
    llmRegistryModel: {
      findFirst: registryFindFirstMock,
      create: registryCreateMock,
    },
  };
  return {
    prisma: {
      ...tx,
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

import { ensureLlmRegistry, syncRegistrySpecToRoutes } from '@/lib/llm/registry';

type Row = {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  purpose: string;
  supportsImage: boolean;
  maxTokens: number;
  contextWindow: number;
  sortOrder: number;
  registryId: string | null;
};

function row(partial: Partial<Row> & { id: string }): Row {
  return {
    providerId: 'prov-1',
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    purpose: 'CHAT',
    supportsImage: false,
    maxTokens: 4096,
    contextWindow: 8192,
    sortOrder: 0,
    registryId: null,
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  registryFindFirstMock.mockResolvedValue(null);
  registryCreateMock.mockImplementation(async ({ data }) => ({
    id: 'reg-new',
    ...data,
  }));
  llmModelUpdateManyMock.mockResolvedValue({ count: 1 });
});

describe('ensureLlmRegistry', () => {
  it('无未链接行时不做任何写操作（幂等快速路径）', async () => {
    llmModelFindManyMock.mockResolvedValueOnce([]);
    await ensureLlmRegistry();
    expect(registryCreateMock).not.toHaveBeenCalled();
    expect(llmModelUpdateManyMock).not.toHaveBeenCalled();
  });

  it('同 (provider, modelId, displayName) 的多用途行归并为一个模型库条目并回填链接', async () => {
    const rows = [
      row({ id: 'm-chat', purpose: 'CHAT', sortOrder: 0 }),
      row({ id: 'm-final', purpose: 'FINAL_SUMMARY', sortOrder: 1 }),
    ];
    // 外层扫描 + 事务内复查
    llmModelFindManyMock
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(rows.map((r) => ({ id: r.id })));

    await ensureLlmRegistry();

    // 只建一个条目，kind=TEXT（混合用途）
    expect(registryCreateMock).toHaveBeenCalledTimes(1);
    expect(registryCreateMock.mock.calls[0][0].data).toMatchObject({
      providerId: 'prov-1',
      modelId: 'gpt-4o',
      displayName: 'GPT-4o',
      kind: 'TEXT',
    });
    // 两行都回填 registryId
    const linkCall = llmModelUpdateManyMock.mock.calls.find(
      (c) => c[0].data.registryId === 'reg-new'
    );
    expect(linkCall![0].where.id.in).toEqual(['m-chat', 'm-final']);
  });

  it('displayName 不同的同 modelId 行不归并（保留管理员刻意注册的变体）', async () => {
    const rows = [
      row({ id: 'm-a', displayName: 'GPT-4o 高温' }),
      row({ id: 'm-b', displayName: 'GPT-4o 低温' }),
    ];
    llmModelFindManyMock
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{ id: 'm-a' }])
      .mockResolvedValueOnce([{ id: 'm-b' }]);

    await ensureLlmRegistry();
    expect(registryCreateMock).toHaveBeenCalledTimes(2);
  });

  it('全部行都是 EMBEDDING 用途时 kind=EMBEDDING', async () => {
    const rows = [
      row({ id: 'm-emb', modelId: 'text-emb', displayName: 'Emb', purpose: 'EMBEDDING' }),
    ];
    llmModelFindManyMock
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{ id: 'm-emb' }]);

    await ensureLlmRegistry();
    expect(registryCreateMock.mock.calls[0][0].data.kind).toBe('EMBEDDING');
  });

  it('并发保护：事务内复查发现行已被链接则跳过建条目', async () => {
    const rows = [row({ id: 'm-1' })];
    llmModelFindManyMock
      .mockResolvedValueOnce(rows)
      // 事务内复查：已被并发 ensure 链接
      .mockResolvedValueOnce([]);

    await ensureLlmRegistry();
    expect(registryCreateMock).not.toHaveBeenCalled();
  });

  it('已有同键模型库条目时复用而不是新建', async () => {
    const rows = [row({ id: 'm-1' })];
    llmModelFindManyMock
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{ id: 'm-1' }]);
    registryFindFirstMock.mockResolvedValueOnce({ id: 'reg-existing' });

    await ensureLlmRegistry();
    expect(registryCreateMock).not.toHaveBeenCalled();
    const linkCall = llmModelUpdateManyMock.mock.calls.find(
      (c) => c[0].data.registryId === 'reg-existing'
    );
    expect(linkCall).toBeTruthy();
  });

  it('归并后把规格写穿回所有路由行（supportsImage 任一为真即为真）', async () => {
    const rows = [
      row({ id: 'm-1', supportsImage: false, contextWindow: 131072, sortOrder: 0 }),
      row({ id: 'm-2', purpose: 'FINAL_SUMMARY', supportsImage: true, contextWindow: 8192, sortOrder: 1 }),
    ];
    llmModelFindManyMock
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(rows.map((r) => ({ id: r.id })));

    await ensureLlmRegistry();

    // 写穿调用（where.registryId）应带归并后的规格：首行规格 + 图片能力取并集
    const syncCall = llmModelUpdateManyMock.mock.calls.find(
      (c) => c[0].where.registryId === 'reg-new'
    );
    expect(syncCall![0].data).toMatchObject({
      supportsImage: true,
      contextWindow: 131072,
      maxTokens: 4096,
    });
  });
});

describe('syncRegistrySpecToRoutes', () => {
  it('按 registryId 批量把规格写到路由行', async () => {
    await syncRegistrySpecToRoutes('reg-9', {
      modelId: 'm',
      displayName: 'M',
      supportsImage: true,
      maxTokens: 2048,
      contextWindow: 65536,
    });
    expect(llmModelUpdateManyMock).toHaveBeenCalledWith({
      where: { registryId: 'reg-9' },
      data: {
        modelId: 'm',
        displayName: 'M',
        supportsImage: true,
        maxTokens: 2048,
        contextWindow: 65536,
      },
    });
  });
});
