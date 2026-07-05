import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthMock,
  assertOwnershipMock,
  ownershipErrorResponseMock,
  findUniqueMock,
  updateManyMock,
  generateTitleMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  assertOwnershipMock: vi.fn(),
  ownershipErrorResponseMock: vi.fn(),
  findUniqueMock: vi.fn(),
  // U50：落库改用原子条件 updateMany（where 带 title:null），避免覆盖生成期间用户手改的标题。
  updateManyMock: vi.fn(),
  generateTitleMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));

vi.mock('@/lib/conversations', () => ({
  assertConversationOwnership: assertOwnershipMock,
  ownershipErrorResponse: ownershipErrorResponseMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    conversation: { findUnique: findUniqueMock, updateMany: updateManyMock },
  },
}));

vi.mock('@/lib/llm/conversationTitle', () => ({
  generateConversationTitle: generateTitleMock,
}));

vi.mock('@/lib/logger', () => {
  const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => noopLogger,
  };
  return {
    logger: noopLogger,
    serializeError: () => ({}),
  };
});

import { POST } from '@/app/api/conversations/[id]/generate-title/route';

function makeReq() {
  return new Request('http://localhost:3000/api/conversations/c1/generate-title', {
    method: 'POST',
  });
}
const params = { params: Promise.resolve({ id: 'c1' }) };

describe('POST /api/conversations/[id]/generate-title', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'u1', role: 'PRO' });
    assertOwnershipMock.mockResolvedValue({ conversationId: 'c1', isOwned: true });
    ownershipErrorResponseMock.mockReturnValue(null);
    findUniqueMock.mockResolvedValue({
      title: null,
      messages: [{ content: '怎么优化 React 性能？' }],
    });
    updateManyMock.mockResolvedValue({ count: 1 });
    generateTitleMock.mockResolvedValue('React 性能优化');
  });

  it('无标题 + 有首条消息 → 生成并落库，返回 title', async () => {
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: 'React 性能优化' });
    expect(generateTitleMock).toHaveBeenCalledWith({
      firstUserMessage: '怎么优化 React 性能？',
    });
    // U50：原子条件写入 —— where 带 title:null，仅当标题仍为空才落库。
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'c1', title: null },
      data: { title: 'React 性能优化' },
    });
  });

  it('已有标题 → 幂等返回，不生成不落库', async () => {
    findUniqueMock.mockResolvedValueOnce({
      title: '已有标题',
      messages: [{ content: 'x' }],
    });
    const res = await POST(makeReq(), params);
    expect(await res.json()).toEqual({ title: '已有标题' });
    expect(generateTitleMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('无用户消息 → 返回 title:null，不生成', async () => {
    findUniqueMock.mockResolvedValueOnce({ title: null, messages: [] });
    const res = await POST(makeReq(), params);
    expect(await res.json()).toEqual({ title: null });
    expect(generateTitleMock).not.toHaveBeenCalled();
  });

  it('生成失败(null) → 返回 title:null，不落库', async () => {
    generateTitleMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), params);
    expect(await res.json()).toEqual({ title: null });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('未登录 → 401', async () => {
    verifyAuthMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(401);
  });

  it('对话不存在 → 404', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(404);
  });
});
