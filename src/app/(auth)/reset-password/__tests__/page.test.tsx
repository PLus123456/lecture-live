import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #19：
 *  a) 成功后用 router.push 会把一次性令牌页留在历史里，后退即重放 → 对刚改完密码的用户
 *     弹「链接已失效」。必须 replace。
 *  b) 链接里没有 token 时，按钮被 disabled 钉死，handleSubmit 里那段缺 token 的报错分支
 *     根本走不到 → 用户面对一个提交不了又零解释的死表单。
 */

const pushMock = vi.fn();
const replaceMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
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
vi.mock('@/components/SiteLogo', () => ({ default: () => <div /> }));
vi.mock('@/components/ThemeSwitcher', () => ({ default: () => <div /> }));
vi.mock('@/lib/i18n', async () => {
  const actual = await vi.importActual<typeof import('@/lib/i18n')>('@/lib/i18n');
  return {
    ...actual,
    useI18n: () => ({ t: actual.getTranslation('en'), locale: 'en' }),
  };
});

import ResetPasswordPage from '@/app/(auth)/reset-password/page';

function setSearch(search: string) {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...window.location, search },
  });
}

function mockFetch(reset: { ok: boolean; status: number }) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/api/site-config')) {
        return { ok: true, status: 200, json: async () => ({ password_min_length: 8 }) };
      }
      return { ok: reset.ok, status: reset.status, json: async () => ({}) };
    })
  );
}

async function submitNewPassword(container: HTMLElement) {
  const user = userEvent.setup();
  const inputs = container.querySelectorAll('input[type="password"]');
  await user.type(inputs[0] as HTMLInputElement, 'passw0rd');
  await user.type(inputs[1] as HTMLInputElement, 'passw0rd');
  await user.click(screen.getByRole('button', { name: /reset password/i }));
}

describe('ResetPasswordPage（#19）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setSearch('?token=raw-token');
    mockFetch({ ok: true, status: 200 });
  });

  it('重置成功后用 replace 跳转，不把一次性令牌页留在历史里', async () => {
    const { container } = render(<ResetPasswordPage />);
    await submitNewPassword(container);

    await waitFor(() => {
      expect(screen.getByText(/password reset/i)).toBeInTheDocument();
    });

    await vi.advanceTimersByTimeAsync(3000);
    expect(replaceMock).toHaveBeenCalledWith('/login');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('缺少 token 时给出解释与重新申请入口，而不是一个死表单', async () => {
    setSearch('');
    const { container } = render(<ResetPasswordPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/open this page from the link in your password reset email/i)
      ).toBeInTheDocument();
    });
    // 表单本身不该再渲染（此前渲染出来但按钮永远 disabled）
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(screen.getByRole('link', { name: /reset your password/i })).toHaveAttribute(
      'href',
      '/forgot-password'
    );
  });

  // token 初值必须是 undefined（"还没读"）而不是 null（"确实没有"）。
  // 若初值为 null，effect 跑之前的那一帧会先渲染出「请从邮件链接打开」——
  // 对着一个完全有效的重置链接闪一句吓人的话，同时造成 SSR/CSR hydration 不匹配。
  // useEffect 在 renderToString 里不执行，正好用来观察这一帧。
  it('首帧（effect 之前）不得显示缺 token 面板', () => {
    setSearch(''); // 即便 URL 真的没有 token，首帧也应先渲染表单，由 effect 再切换
    const html = renderToString(<ResetPasswordPage />);
    expect(html).not.toContain('Open this page from the link');
    expect(html).toContain('type="password"');
  });

  it('带 token 时正常渲染表单', async () => {
    const { container } = render(<ResetPasswordPage />);
    await waitFor(() => {
      expect(container.querySelectorAll('input[type="password"]')).toHaveLength(2);
    });
    expect(
      screen.queryByText(/open this page from the link in your password reset email/i)
    ).not.toBeInTheDocument();
  });
});
