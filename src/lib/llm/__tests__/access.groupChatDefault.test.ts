import { beforeEach, describe, expect, it, vi } from 'vitest';

// 组默认聊天模型（chatModelId）在 resolveAuthorizedLlmSelection 里的行为：
//  - 未指定模型时优先生效，且绕过 allowedModels 门禁（组绑定=管理员决策）
//  - 失效 id（模型已删）静默回落全局默认（并恢复默认模型授权校验）
//  - 摘要路径（enforceDefaultModelAccess:false）不套用组聊天默认

const {
  userFindUniqueMock,
  getModelByIdMock,
  getProviderForPurposeMock,
  resolveUserDefaultChatModelIdMock,
} = vi.hoisted(() => ({
  userFindUniqueMock: vi.fn(),
  getModelByIdMock: vi.fn(),
  getProviderForPurposeMock: vi.fn(),
  resolveUserDefaultChatModelIdMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: userFindUniqueMock } },
}));

vi.mock('@/lib/llm/gateway', () => ({
  getModelById: getModelByIdMock,
  getProviderForPurpose: getProviderForPurposeMock,
  parseProviders: () => ({}),
}));

vi.mock('@/lib/userRoles', () => ({
  resolveUserFeatureFlags: async () => ({
    maxThinkingDepth: 'high',
    allowRealtimeSummary: true,
    allowFinalSummary: true,
  }),
  resolveUserDefaultChatModelId: resolveUserDefaultChatModelIdMock,
  clampDepthToCap: (d: string) => d,
}));

import {
  resolveAuthorizedLlmSelection,
  LLMAccessError,
} from '@/lib/llm/access';

const GROUP_MODEL = {
  name: 'prov',
  displayName: 'Group Model',
  apiBase: 'https://x',
  apiKey: 'k',
  model: 'group-model',
  thinkingDepth: 'medium',
  thinkingMode: 'NONE',
  supportsThinkingDepth: false,
  supportsImage: false,
  maxTokens: 4096,
  contextWindow: 8192,
  temperature: 0.6,
  isAnthropic: false,
  dbModelId: 'db-group-model',
};

beforeEach(() => {
  vi.clearAllMocks();
  // 受限用户：allowedModels 里没有组默认模型
  userFindUniqueMock.mockResolvedValue({
    role: 'FREE',
    allowedModels: 'some-other-model',
    customGroupId: 'vip',
  });
  resolveUserDefaultChatModelIdMock.mockResolvedValue('db-group-model');
  getModelByIdMock.mockResolvedValue(GROUP_MODEL);
  // 全局 CHAT 默认（不在 allowedModels 内 → 若走到这条路径会 403）
  getProviderForPurposeMock.mockResolvedValue({
    ...GROUP_MODEL,
    displayName: 'Global Default',
    dbModelId: 'db-global-default',
  });
});

describe('组默认聊天模型', () => {
  it('未指定模型 → 用组默认，且绕过 allowedModels 门禁', async () => {
    const selection = await resolveAuthorizedLlmSelection('user-1', undefined);
    expect(selection.modelId).toBe('db-group-model');
    expect(selection.providerConfig?.dbModelId).toBe('db-group-model');
  });

  it('伪造/陈旧的模型 id → 同样落到组默认（与空 id 同口径）', async () => {
    getModelByIdMock.mockImplementation(async (id: string) =>
      id === 'db-group-model'
        ? GROUP_MODEL
        : { ...GROUP_MODEL, dbModelId: undefined } // 查无此模型 → 回落 env 形态
    );
    const selection = await resolveAuthorizedLlmSelection('user-1', 'forged-id');
    expect(selection.modelId).toBe('db-group-model');
  });

  it('组默认已失效（模型被删）→ 回落全局默认并恢复授权校验（此处默认模型未授权 → 403）', async () => {
    getModelByIdMock.mockResolvedValue({ ...GROUP_MODEL, dbModelId: undefined });
    await expect(
      resolveAuthorizedLlmSelection('user-1', undefined)
    ).rejects.toBeInstanceOf(LLMAccessError);
  });

  it('摘要路径（enforceDefaultModelAccess:false）不套用组聊天默认', async () => {
    const selection = await resolveAuthorizedLlmSelection('user-1', undefined, {
      enforceDefaultModelAccess: false,
    });
    expect(selection.modelId).toBeUndefined();
    expect(selection.providerConfig).toBeUndefined();
    expect(resolveUserDefaultChatModelIdMock).not.toHaveBeenCalled();
  });

  it('未绑定组默认（null）→ 走原有全局默认门禁路径', async () => {
    resolveUserDefaultChatModelIdMock.mockResolvedValue(null);
    await expect(
      resolveAuthorizedLlmSelection('user-1', undefined)
    ).rejects.toBeInstanceOf(LLMAccessError);
  });
});
