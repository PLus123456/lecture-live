import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../../tests/utils/http';

/**
 * /api/llm/chat/compress 的「不支持 vs 不存在」语义分流（L3）。
 * 压缩本体（compressHistory / 边界定位）在各自的隔离单测里覆盖，这里只测入口分支。
 */

const {
  verifyAuthMock,
  enforceApiRateLimitMock,
  conversationFindUniqueMock,
  conversationMessageCreateMock,
  callLLMMock,
  resolveAuthorizedLlmSelectionMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceApiRateLimitMock: vi.fn(),
  conversationFindUniqueMock: vi.fn(),
  conversationMessageCreateMock: vi.fn(),
  callLLMMock: vi.fn(),
  resolveAuthorizedLlmSelectionMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/payment/entitlementAdmission', () => ({
  isPaymentBenefitAvailable: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/rateLimit', () => ({ enforceApiRateLimit: enforceApiRateLimitMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    conversation: { findUnique: conversationFindUniqueMock },
    conversationMessage: { create: conversationMessageCreateMock },
  },
}));
vi.mock('@/lib/llm/gateway', () => ({ callLLM: callLLMMock }));
vi.mock('@/lib/llm/access', () => ({
  LLMAccessError: class LLMAccessError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'LLMAccessError';
    }
  },
  resolveAuthorizedLlmSelection: resolveAuthorizedLlmSelectionMock,
}));

import { POST } from '@/app/api/llm/chat/compress/route';

function makeReq(body: Record<string, unknown>) {
  return createJsonRequest('http://localhost:3000/api/llm/chat/compress', {
    method: 'POST',
    body,
  });
}

describe('POST /api/llm/chat/compress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    enforceApiRateLimitMock.mockResolvedValue(null);
    callLLMMock.mockResolvedValue('summary');
    conversationMessageCreateMock.mockResolvedValue({ id: 'm1' });
    resolveAuthorizedLlmSelectionMock.mockResolvedValue({
      user: { role: 'PRO' },
      modelId: undefined,
      providerName: undefined,
      featureFlags: {},
    });
  });

  it('对话不存在 → 404', async () => {
    conversationFindUniqueMock.mockResolvedValue(null);
    const res = await POST(makeReq({ conversationId: 'c-missing' }));
    expect(res.status).toBe(404);
  });

  it('他人对话 → 404（不泄漏存在性）', async () => {
    conversationFindUniqueMock.mockResolvedValue({
      id: 'c-other',
      userId: 'user-2',
      session: { userId: 'user-2', targetLang: 'zh' },
      endedAt: null,
      messages: [],
    });
    const res = await POST(makeReq({ conversationId: 'c-other' }));
    expect(res.status).toBe(404);
  });

  it('L3：本人的全局对话（无 session）→ 409 + 可读 message，不再谎报 404 not found', async () => {
    conversationFindUniqueMock.mockResolvedValue({
      id: 'c-global',
      userId: 'user-1',
      session: null,
      endedAt: null,
      messages: [],
    });
    const res = await POST(makeReq({ conversationId: 'c-global' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error?: string;
      message?: string;
    };
    expect(body.error).toBe('compression_unsupported');
    // 前端 compressActive 直接展示 message，必须存在且不能是「找不到对话」
    expect(body.message).toBeTruthy();
    expect(body.message).not.toMatch(/not found/i);
  });

  it('已结束的对话 → 409', async () => {
    conversationFindUniqueMock.mockResolvedValue({
      id: 'c-closed',
      userId: 'user-1',
      session: { userId: 'user-1', targetLang: 'zh' },
      endedAt: new Date(),
      messages: [],
    });
    const res = await POST(makeReq({ conversationId: 'c-closed' }));
    expect(res.status).toBe(409);
  });

  /**
   * M16：主动压缩把「早期对话原文」发给 LLM，此前硬编码 `{ purpose: 'CHAT' }` ——
   * 受限组用户被授权只能用模型 X，其对话原文却被送到全局默认 CHAT 模型上，
   * 组绑定的 chatModelId 也被绕过。
   */
  describe('M16：压缩调用走用户已授权的模型路由', () => {
    function conversationWithTurns() {
      const messages = [];
      for (let i = 0; i < 4; i++) {
        messages.push({
          id: `u${i}`,
          role: 'user',
          content: `问题 ${i}`,
          transcriptOffsetMs: i * 1000,
          createdAt: new Date(),
        });
        messages.push({
          id: `a${i}`,
          role: 'assistant',
          content: `回答 ${i}`,
          transcriptOffsetMs: i * 1000,
          createdAt: new Date(),
        });
      }
      return {
        id: 'c-ok',
        userId: 'user-1',
        session: { userId: 'user-1', targetLang: 'zh' },
        endedAt: null,
        messages,
      };
    }

    it('组绑定/受限用户解析出的 modelId 被透传给 compressHistory 的 callLLM', async () => {
      conversationFindUniqueMock.mockResolvedValue(conversationWithTurns());
      resolveAuthorizedLlmSelectionMock.mockResolvedValue({
        user: { role: 'FREE' },
        modelId: 'model-allowed-only',
        featureFlags: {},
      });

      const res = await POST(makeReq({ conversationId: 'c-ok' }));
      expect(res.status).toBe(200);

      expect(callLLMMock).toHaveBeenCalledTimes(1);
      expect(callLLMMock.mock.calls[0][2]).toEqual({
        modelId: 'model-allowed-only',
      });
      expect(callLLMMock.mock.calls[0][2]).not.toEqual({ purpose: 'CHAT' });
    });

    it('用户无权使用默认模型时 403，而不是偷偷用它压缩', async () => {
      conversationFindUniqueMock.mockResolvedValue(conversationWithTurns());
      const { LLMAccessError } = await import('@/lib/llm/access');
      resolveAuthorizedLlmSelectionMock.mockRejectedValue(
        new LLMAccessError('Requested model is not allowed')
      );

      const res = await POST(makeReq({ conversationId: 'c-ok' }));
      expect(res.status).toBe(403);
      expect(callLLMMock).not.toHaveBeenCalled();
    });
  });
});
