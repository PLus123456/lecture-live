import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * H1 回归：伪造/陈旧的模型 id 不得绕过用户组模型绑定。
 *
 * resolveAuthorizedLlmSelection 对「非空但既非已配置 DB 模型、也非已配置 provider 名」的 id
 * 会 fall-through 到默认 CHAT 模型。此前该分支不校验默认模型授权，受限用户发
 * model:"does-not-exist" 即可拿到（通常更强的）默认模型。修复后 fall-through 也要跑
 * 默认模型授权校验（与空 id 分支一致）。
 */

const { userFindUniqueMock, getModelByIdMock, getProviderForPurposeMock, parseProvidersMock } =
  vi.hoisted(() => ({
    userFindUniqueMock: vi.fn(),
    getModelByIdMock: vi.fn(),
    getProviderForPurposeMock: vi.fn(),
    parseProvidersMock: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: userFindUniqueMock } },
}));

vi.mock('@/lib/llm/gateway', () => ({
  getModelById: getModelByIdMock,
  getProviderForPurpose: getProviderForPurposeMock,
  parseProviders: parseProvidersMock,
}));

vi.mock('@/lib/userRoles', () => ({
  resolveUserFeatureFlags: async () => ({
    maxThinkingDepth: 'high',
    allowRealtimeSummary: true,
    allowFinalSummary: true,
  }),
  // 组默认聊天模型：这些用例都验证「无组绑定」下的 allowedModels 门禁，恒返回 null
  resolveUserDefaultChatModelId: async () => null,
  clampDepthToCap: (d: string) => d,
}));

import {
  resolveAuthorizedLlmSelection,
  LLMAccessError,
} from '@/lib/llm/access';

// 默认 CHAT provider：dbModelId='default-chat'。是否在 allowedModels 内决定放行/拒绝。
const DEFAULT_CHAT = {
  dbModelId: 'default-chat',
  model: 'gpt-4o',
  name: 'openai-default',
};

// 未知 id 时 getModelById 的行为：回落到 env active provider（dbModelId 为 undefined）。
const ENV_FALLBACK = { dbModelId: undefined, model: 'env-model', name: 'env-active' };

describe('resolveAuthorizedLlmSelection — 伪造模型 id 门禁（H1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderForPurposeMock.mockResolvedValue(DEFAULT_CHAT);
    parseProvidersMock.mockReturnValue({}); // 无任何 env provider 命名匹配
    getModelByIdMock.mockImplementation(async (id: string) =>
      id === DEFAULT_CHAT.dbModelId
        ? DEFAULT_CHAT
        : ENV_FALLBACK
    );
  });

  it('受限用户 + 伪造 id + 默认模型不在 allowedModels → 抛 LLMAccessError（不再放行默认模型）', async () => {
    userFindUniqueMock.mockResolvedValue({
      role: 'FREE',
      allowedModels: 'some-other-model', // 不含 default-chat / gpt-4o / openai-default
      customGroupId: null,
    });

    await expect(
      resolveAuthorizedLlmSelection('user-1', 'does-not-exist')
    ).rejects.toBeInstanceOf(LLMAccessError);
  });

  it('受限用户 + 伪造 id + 默认模型恰在 allowedModels → 放行（回落默认模型，空 selection）', async () => {
    userFindUniqueMock.mockResolvedValue({
      role: 'FREE',
      allowedModels: 'default-chat', // 默认模型被授权
      customGroupId: null,
    });

    const sel = await resolveAuthorizedLlmSelection('user-1', 'does-not-exist');
    expect(sel.providerConfig).toBeUndefined();
    expect(sel.modelId).toBeUndefined();
    expect(sel.user.role).toBe('FREE');
  });

  it('ADMIN + 伪造 id → 不校验、放行（回落默认模型）', async () => {
    userFindUniqueMock.mockResolvedValue({
      role: 'ADMIN',
      allowedModels: 'anything',
      customGroupId: null,
    });

    const sel = await resolveAuthorizedLlmSelection('admin-1', 'does-not-exist');
    expect(sel.providerConfig).toBeUndefined();
  });

  it('回归：受限用户不传 model + 默认模型不在 allowedModels → 仍抛 LLMAccessError', async () => {
    userFindUniqueMock.mockResolvedValue({
      role: 'FREE',
      allowedModels: 'some-other-model',
      customGroupId: null,
    });

    await expect(
      resolveAuthorizedLlmSelection('user-1', undefined)
    ).rejects.toBeInstanceOf(LLMAccessError);
  });

  it('合法授权的 DB 模型 id → 正常返回 providerConfig', async () => {
    userFindUniqueMock.mockResolvedValue({
      role: 'FREE',
      allowedModels: 'default-chat',
      customGroupId: null,
    });

    const sel = await resolveAuthorizedLlmSelection('user-1', 'default-chat');
    expect(sel.modelId).toBe('default-chat');
    expect(sel.providerConfig).toEqual(DEFAULT_CHAT);
  });
});
