import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #11 回归：验证邮件没发出去时，注册页此前照样显示绿色的「请查收验证邮件」，
 * 用户会一直等一封根本不存在的邮件。这里锁定告警态文案确实渲染。
 */

const pushMock = vi.fn();
const registerUserMock = vi.fn();

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
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ registerUser: registerUserMock }),
}));
vi.mock('@/components/SiteLogo', () => ({ default: () => <div /> }));
vi.mock('@/components/ThemeSwitcher', () => ({ default: () => <div /> }));
vi.mock('dompurify', () => ({ default: { sanitize: (s: string) => s } }));
vi.mock('@/lib/i18n', async () => {
  const actual = await vi.importActual<typeof import('@/lib/i18n')>('@/lib/i18n');
  return {
    ...actual,
    useI18n: () => ({ t: actual.getTranslation('en'), locale: 'en' }),
  };
});

import RegisterPage from '@/app/(auth)/register/page';

// 注册页的 <label> 没有 htmlFor/id 关联到 input，getByLabelText 取不到，按 type 选。
async function submitRegistration(container: HTMLElement) {
  const user = userEvent.setup();
  const byType = (type: string) =>
    container.querySelector(`input[type="${type}"]`) as HTMLInputElement;

  await user.type(byType('text'), '张三');
  await user.type(byType('email'), 'user@example.com');
  await user.type(byType('password'), 'passw0rd');
  await user.click(screen.getByRole('button', { name: /create account/i }));
}

describe('RegisterPage — 验证邮件发送失败态（#11）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 站点配置拉取：注册页启动时 fetch /api/site-config
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ allow_registration: true, password_min_length: 8 }),
      })
    );
  });

  it('发信失败时显示告警文案，而不是「请查收验证邮件」', async () => {
    registerUserMock.mockResolvedValue({
      verificationRequired: true,
      emailSendFailed: true,
      email: 'user@example.com',
    });

    const { container } = render(<RegisterPage />);
    await submitRegistration(container);

    await waitFor(() => {
      expect(
        screen.getByText(/account created, but the email could not be sent/i)
      ).toBeInTheDocument();
    });
    // 绿色成功态文案必须消失，否则等于继续骗用户去查收
    expect(screen.queryByText(/^check your email$/i)).not.toBeInTheDocument();
    // 自助恢复入口仍在：SMTP 修好后用户点它即可
    expect(
      screen.getByRole('button', { name: /resend verification email/i })
    ).toBeInTheDocument();
  });

  it('发信成功时仍是原来的「请查收」成功态', async () => {
    registerUserMock.mockResolvedValue({
      verificationRequired: true,
      email: 'user@example.com',
    });

    const { container } = render(<RegisterPage />);
    await submitRegistration(container);

    await waitFor(() => {
      expect(screen.getByText(/^check your email$/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/account created, but the email could not be sent/i)
    ).not.toBeInTheDocument();
  });
});
