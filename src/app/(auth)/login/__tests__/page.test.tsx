import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pushMock = vi.fn();
const loginUserMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

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

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    loginUser: loginUserMock,
  }),
}));

vi.mock('@/lib/i18n', async () => {
  const actual = await vi.importActual<typeof import('@/lib/i18n')>('@/lib/i18n');
  return {
    ...actual,
    useI18n: () => ({
      t: actual.getTranslation('en'),
      locale: 'en',
    }),
  };
});

import LoginPage from '@/app/(auth)/login/page';

describe('LoginPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          site_name: 'LectureLive QA',
          site_description: 'Testing sign in',
          site_announcement: '',
          footer_code: '',
          allow_registration: true,
        }),
      })
    );
  });

  it('加载站点配置并展示登录表单', async () => {
    render(<LoginPage />);

    expect(await screen.findByText('LectureLive QA')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Register' })).toHaveAttribute(
      'href',
      '/register'
    );
  });

  it('提交成功后跳转到首页', async () => {
    loginUserMock.mockResolvedValue({
      user: { id: 'user-1' },
      token: '__cookie_session__',
    });

    const user = userEvent.setup();
    const { container } = render(<LoginPage />);
    const emailInput = await waitFor(() =>
      container.querySelector('input[type="email"]')
    );
    const passwordInput = container.querySelector('input[type="password"]');

    expect(emailInput).toBeTruthy();
    expect(passwordInput).toBeTruthy();

    await user.type(emailInput as HTMLInputElement, 'alice@example.com');
    await user.type(passwordInput as HTMLInputElement, 'Abcd1234');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => {
      expect(loginUserMock).toHaveBeenCalledWith(
        'alice@example.com',
        'Abcd1234'
      );
      expect(pushMock).toHaveBeenCalledWith('/home');
    });
  });
});
