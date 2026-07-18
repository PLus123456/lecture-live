import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #9 回归：
 *  1) 服务端永远填硬编码中文 message，早先 `data?.message ?? t(...)` 让英文键成了死代码
 *     —— locale=en 时必须渲染英文键，而不是服务端那句中文。
 *  2) 限流 429 只回 { error } 无 message，早先落到 `?? t(...)` 被渲染成绿色「已发送」，
 *     用户干等一封永不会来的信 —— 必须显示限流提示。
 */

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

vi.mock('@/lib/i18n', async () => {
  const actual = await vi.importActual<typeof import('@/lib/i18n')>('@/lib/i18n');
  return {
    ...actual,
    useI18n: () => ({ t: actual.getTranslation('en'), locale: 'en' }),
  };
});

import ForgotPasswordPage from '@/app/(auth)/forgot-password/page';

const SERVER_CHINESE_MESSAGE = '如果该邮箱对应一个账号，我们已发送密码重置邮件，请查收。';

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

async function submit() {
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox'), 'user@example.com');
  await user.click(screen.getByRole('button', { name: /send reset link/i }));
}

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('成功时渲染英文 i18n 文案，而不是服务端返回的中文 message', async () => {
    mockFetch({ ok: true, status: 200, body: { message: SERVER_CHINESE_MESSAGE } });
    render(<ForgotPasswordPage />);

    await submit();

    await waitFor(() => {
      expect(
        screen.getByText(/if that email matches an account/i)
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(SERVER_CHINESE_MESSAGE)).not.toBeInTheDocument();
  });

  it('限流 429 显示限流提示，绝不显示「已发送」', async () => {
    mockFetch({ ok: false, status: 429, body: { error: 'Too many requests' } });
    render(<ForgotPasswordPage />);

    await submit();

    await waitFor(() => {
      expect(screen.getByText(/too many attempts/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/if that email matches an account/i)).not.toBeInTheDocument();
    // 表单要留在原地，让用户能改邮箱重试——不能切到「已发送」成功态
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
  });

  it('其他失败状态显示通用失败提示，不显示「已发送」', async () => {
    mockFetch({ ok: false, status: 500, body: { error: 'boom' } });
    render(<ForgotPasswordPage />);

    await submit();

    await waitFor(() => {
      expect(screen.getByText(/could not send the reset email/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/if that email matches an account/i)).not.toBeInTheDocument();
  });
});
