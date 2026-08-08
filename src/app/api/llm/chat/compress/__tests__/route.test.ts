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
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceApiRateLimitMock: vi.fn(),
  conversationFindUniqueMock: vi.fn(),
  conversationMessageCreateMock: vi.fn(),
  callLLMMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceApiRateLimit: enforceApiRateLimitMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    conversation: { findUnique: conversationFindUniqueMock },
    conversationMessage: { create: conversationMessageCreateMock },
  },
}));
vi.mock('@/lib/llm/gateway', () => ({ callLLM: callLLMMock }));

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
});
