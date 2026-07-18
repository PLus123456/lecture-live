import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #9 回归：verifyFailed 是死代码——服务端失败分支永远填硬编码中文 error，
 * 页面写的是 `data?.error ?? t('auth.verifyFailed')`，于是英文用户读到中文。
 */

const pushMock = vi.fn();
const setAuthMock = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: { setAuth: typeof setAuthMock }) => unknown) =>
    selector({ setAuth: setAuthMock }),
}));
vi.mock('@/lib/i18n', async () => {
  const actual = await vi.importActual<typeof import('@/lib/i18n')>('@/lib/i18n');
  return {
    ...actual,
    useI18n: () => ({ t: actual.getTranslation('en'), locale: 'en' }),
  };
});

import VerifyEmailPage from '@/app/(auth)/verify-email/page';

const SERVER_CHINESE_ERROR = '验证链接无效或已过期，请重新获取';

function setToken(token: string | null) {
  const search = token === null ? '' : `?token=${encodeURIComponent(token)}`;
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...window.location, search },
  });
}

function mockFetch(response: { ok: boolean; status: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    })
  );
}

describe('VerifyEmailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setToken('raw-token');
  });

  it('验证失败时渲染英文 i18n 文案，而不是服务端中文 error', async () => {
    mockFetch({ ok: false, status: 400, body: { error: SERVER_CHINESE_ERROR } });
    render(<VerifyEmailPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/this verification link is invalid or expired/i)
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(SERVER_CHINESE_ERROR)).not.toBeInTheDocument();
  });

  it('限流 429 显示限流提示而非「链接无效」', async () => {
    mockFetch({ ok: false, status: 429, body: { error: 'Too many requests' } });
    render(<VerifyEmailPage />);

    await waitFor(() => {
      expect(screen.getByText(/too many attempts/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/this verification link is invalid or expired/i)
    ).not.toBeInTheDocument();
  });

  it('验证成功时同步 auth store 并显示成功文案', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: {
        verified: true,
        user: { id: 'u1', email: 'a@b.com', displayName: 'A', role: 'FREE' },
        token: 'client-session',
      },
    });
    render(<VerifyEmailPage />);

    await waitFor(() => {
      expect(setAuthMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText(/email verified/i)).toBeInTheDocument();
  });

  it('缺少令牌时显示对应提示且不发请求', async () => {
    setToken(null);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(<VerifyEmailPage />);

    await waitFor(() => {
      expect(screen.getByText(/missing verification token/i)).toBeInTheDocument();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
