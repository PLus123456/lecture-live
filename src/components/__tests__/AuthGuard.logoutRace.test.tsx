import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  restoreSession: vi.fn(async () => true),
  logout: vi.fn(async () => ({
    durableRevocation: true,
    status: 200,
    pendingRevocation: false,
  })),
  auth: {
    user: { id: 'user-a' } as { id: string } | null,
    token: '__cookie_session__' as string | null,
    sessionChecked: true,
    hasPendingLogout: false,
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    ...mocks.auth,
    restoreSession: mocks.restoreSession,
    logout: mocks.logout,
  }),
}));
vi.mock('@/stores/authStore', () => ({
  isAuthHydrated: () => true,
  useAuthStore: { persist: { onFinishHydration: vi.fn() } },
}));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import AuthGuard from '@/components/layout/AuthGuard';

describe('AuthGuard explicit logout boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.user = { id: 'user-a' };
    mocks.auth.token = '__cookie_session__';
    mocks.auth.sessionChecked = true;
    mocks.auth.hasPendingLogout = false;
  });

  it('sessionChecked=true 的显式匿名态直接跳登录，不并发 restore/refresh', async () => {
    const view = render(<AuthGuard><div>private</div></AuthGuard>);
    expect(view.getByText('private')).toBeTruthy();

    mocks.auth.user = null;
    mocks.auth.token = null;
    view.rerender(<AuthGuard><div>private</div></AuthGuard>);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login'));
    expect(mocks.restoreSession).not.toHaveBeenCalled();
  });

  it('pending 撤销优先于已水合主体，重试 logout 成功后才去登录页', async () => {
    mocks.auth.hasPendingLogout = true;
    const view = render(<AuthGuard><div>private</div></AuthGuard>);

    expect(view.queryByText('private')).toBeNull();
    expect(view.getByText('auth.logoutIncomplete')).toBeTruthy();
    expect(mocks.restoreSession).not.toHaveBeenCalled();

    fireEvent.click(view.getByText('common.retry'));
    await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
    expect(mocks.replace).toHaveBeenCalledWith('/login');
  });
});
