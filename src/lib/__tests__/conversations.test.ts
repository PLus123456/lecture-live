import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUniqueMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    conversation: {
      findUnique: findUniqueMock,
    },
  },
}));

import {
  assertConversationOwnership,
  collectSessionIds,
  ConversationOwnershipError,
  getConversationOwnership,
} from '@/lib/conversations';

describe('collectSessionIds', () => {
  it('返回 legacy sessionId 优先 + junction 行，去重', () => {
    expect(
      collectSessionIds({
        sessionId: 's1',
        sessions: [{ sessionId: 's2' }, { sessionId: 's1' }],
      })
    ).toEqual(['s1', 's2']);
  });

  it('仅 junction 行', () => {
    expect(
      collectSessionIds({
        sessionId: null,
        sessions: [{ sessionId: 'a' }, { sessionId: 'b' }],
      })
    ).toEqual(['a', 'b']);
  });

  it('完全没挂载 → 空数组', () => {
    expect(collectSessionIds({ sessionId: null, sessions: [] })).toEqual([]);
  });
});

describe('getConversationOwnership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('对话不存在返回 null', async () => {
    findUniqueMock.mockResolvedValue(null);
    const result = await getConversationOwnership('c1', 'u1');
    expect(result).toBeNull();
  });

  it('legacy sessionId 属于用户 → isOwned=true', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'c1',
      sessionId: 's1',
      session: { userId: 'u1' },
      sessions: [],
    });
    const result = await getConversationOwnership('c1', 'u1');
    expect(result).toEqual({
      conversationId: 'c1',
      isOwned: true,
      isFreshGlobal: false,
    });
  });

  it('legacy sessionId 属于他人 + junction 命中 → isOwned=true', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'c1',
      sessionId: 's-foreign',
      session: { userId: 'other' },
      sessions: [{ session: { userId: 'u1' } }],
    });
    const result = await getConversationOwnership('c1', 'u1');
    expect(result?.isOwned).toBe(true);
  });

  it('两侧均不属于用户 → isOwned=false', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'c1',
      sessionId: 's-foreign',
      session: { userId: 'other' },
      sessions: [{ session: { userId: 'other' } }],
    });
    const result = await getConversationOwnership('c1', 'u1');
    expect(result?.isOwned).toBe(false);
    expect(result?.isFreshGlobal).toBe(false);
  });

  it('sessionId=null & 0 junction → isFreshGlobal=true, isOwned=false', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'c1',
      sessionId: null,
      session: null,
      sessions: [],
    });
    const result = await getConversationOwnership('c1', 'u1');
    expect(result?.isFreshGlobal).toBe(true);
    expect(result?.isOwned).toBe(false);
  });
});

describe('assertConversationOwnership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('不存在 → 抛 not-found', async () => {
    findUniqueMock.mockResolvedValue(null);
    await expect(assertConversationOwnership('c1', 'u1')).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('未拥有 → 抛 forbidden', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'c1',
      sessionId: 's1',
      session: { userId: 'other' },
      sessions: [],
    });
    await expect(assertConversationOwnership('c1', 'u1')).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });

  it('拥有 → 正常返回', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'c1',
      sessionId: 's1',
      session: { userId: 'u1' },
      sessions: [],
    });
    const r = await assertConversationOwnership('c1', 'u1');
    expect(r.isOwned).toBe(true);
  });

  it('ConversationOwnershipError instance check', async () => {
    findUniqueMock.mockResolvedValue(null);
    try {
      await assertConversationOwnership('c1', 'u1');
      throw new Error('should not reach here');
    } catch (err) {
      expect(err).toBeInstanceOf(ConversationOwnershipError);
    }
  });
});
