import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 用户管理搜索：短前缀（"a"）命中行多、响应更慢，晚于完整关键词（"alice"）到达时不得把
 * 列表覆盖回宽泛结果（否则「全选 → 批量删除」会落到看不见的错误集合上）；输入去抖后才查询。
 */

const stableT = (key: string) => key;
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: stableT, locale: 'zh', setLocale: () => {} }),
}));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: { token: string; user: { id: string } }) => unknown) =>
    selector({ token: 'tok', user: { id: 'admin-1' } }),
}));
vi.mock('@/stores/toastStore', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import UserManagementPanel from '@/components/admin/UserManagementPanel';

function makeUser(id: string, name: string) {
  return {
    id,
    email: `${name.toLowerCase()}@example.com`,
    displayName: name,
    role: 'FREE',
    status: 1,
    points: 0,
    originalRole: null,
    roleExpiresAt: null,
    avatarPath: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    transcriptionMinutesUsed: 0,
    transcriptionMinutesLimit: 60,
    storageHoursUsed: 0,
    storageHoursLimit: 10,
    allowedModels: '',
    customGroupId: null,
  };
}

type Pending = { filter: string; resolve: (users: unknown[]) => void };
let pending: Pending[];

describe('UserManagementPanel 搜索时序', () => {
  beforeEach(() => {
    pending = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/admin/groups')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ groups: [] }) });
        }
        if (url.startsWith('/api/admin/users')) {
          const filter = new URL(url, 'http://x').searchParams.get('filter') ?? '';
          return new Promise((resolveResponse) => {
            pending.push({
              filter,
              resolve: (users) =>
                resolveResponse({ ok: true, status: 200, json: async () => ({ users }) }),
            });
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderWithInitialList() {
    const user = userEvent.setup();
    render(<UserManagementPanel />);

    // 首屏（无筛选）
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0].resolve([makeUser('u1', 'Alice'), makeUser('u2', 'Alan'), makeUser('u3', 'Bob')]);
    });
    await screen.findByText('bob@example.com');

    await user.click(screen.getByRole('button', { name: /Filter/ }));
    const input = screen.getByPlaceholderText('admin.searchByNameEmail');
    return { user, input };
  }

  it('逐字输入时去抖，只为停顿后的关键词发请求', async () => {
    const { user, input } = await renderWithInitialList();

    await user.type(input, 'a');
    await waitFor(() => expect(pending.map((p) => p.filter)).toContain('a'), { timeout: 2000 });
    await user.type(input, 'lice');
    await waitFor(() => expect(pending.map((p) => p.filter)).toContain('alice'), { timeout: 2000 });

    // 不会为 "al"/"ali"/"alic" 各发一次
    expect(pending.map((p) => p.filter)).toEqual(['', 'a', 'alice']);
  });

  it('慢的旧查询（"a"）晚于新查询（"alice"）返回时，不得覆盖列表', async () => {
    const { user, input } = await renderWithInitialList();

    await user.type(input, 'a');
    await waitFor(() => expect(pending.map((p) => p.filter)).toContain('a'), { timeout: 2000 });
    await user.type(input, 'lice');
    await waitFor(() => expect(pending.map((p) => p.filter)).toContain('alice'), { timeout: 2000 });

    const narrow = pending.find((p) => p.filter === 'alice')!;
    const broad = pending.find((p) => p.filter === 'a')!;
    await act(async () => {
      narrow.resolve([makeUser('u1', 'Alice')]);
    });
    await screen.findByText('alice@example.com');
    await act(async () => {
      broad.resolve([makeUser('u1', 'Alice'), makeUser('u2', 'Alan')]);
    });

    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.queryByText('alan@example.com')).toBeNull();
    expect(screen.queryByText('bob@example.com')).toBeNull();
  });
});
