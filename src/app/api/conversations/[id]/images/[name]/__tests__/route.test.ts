import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyAuth: vi.fn(),
  assertOwnership: vi.fn(),
  readImage: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: mocks.verifyAuth }));
vi.mock('@/lib/conversations', () => ({
  assertConversationOwnership: mocks.assertOwnership,
  ownershipErrorResponse: vi.fn(),
}));
vi.mock('@/lib/llm/chatImageStorage', () => ({ readChatImage: mocks.readImage }));

import { GET } from '@/app/api/conversations/[id]/images/[name]/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyAuth.mockResolvedValue({
    id: 'user-a',
    email: 'a@example.com',
    role: 'FREE',
  });
  mocks.assertOwnership.mockResolvedValue(undefined);
  mocks.readImage.mockResolvedValue({
    data: Buffer.from('private-image'),
    contentType: 'image/png',
  });
});

describe('private conversation image cache policy', () => {
  it('每次都重新走 ownership check，不允许跨账号复用 immutable HTTP cache', async () => {
    const response = await GET(
      new Request('http://localhost/api/conversations/c1/images/p.png'),
      { params: Promise.resolve({ id: 'c1', name: 'p.png' }) }
    );

    expect(response.status).toBe(200);
    expect(mocks.assertOwnership).toHaveBeenCalledWith('c1', 'user-a');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('cache-control')).not.toContain('immutable');
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
  });
});
