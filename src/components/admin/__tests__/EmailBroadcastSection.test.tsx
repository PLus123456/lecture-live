import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #14 群发面板。群发不可撤回 —— 这里锁定「统计人数 → 二次确认」这道闸不能被绕过。
 */

vi.mock('@/lib/i18n', async () => {
  const actual = await vi.importActual<typeof import('@/lib/i18n')>('@/lib/i18n');
  return {
    ...actual,
    useI18n: () => ({ t: actual.getTranslation('en'), locale: 'en' }),
  };
});

import EmailBroadcastSection from '@/components/admin/EmailBroadcastSection';

const fetchMock = vi.fn();

async function fillContent(container: HTMLElement) {
  const user = userEvent.setup();
  const inputs = container.querySelectorAll('input[type="text"]');
  await user.type(inputs[0] as HTMLInputElement, 'Subject');
  await user.type(inputs[1] as HTMLInputElement, 'Heading');
  await user.type(container.querySelector('textarea') as HTMLTextAreaElement, 'Body');
  return user;
}

function lastCallBody(): Record<string, unknown> {
  const calls = fetchMock.mock.calls;
  return JSON.parse(calls[calls.length - 1][1].body);
}

describe('EmailBroadcastSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        mode: 'preview',
        recipientCount: 42,
        truncated: false,
        marketingEnabled: true,
      }),
    });
  });

  it('内容填齐前不能触发任何请求', async () => {
    render(<EmailBroadcastSection />);
    const countBtn = screen.getByRole('button', { name: /count recipients/i });
    expect(countBtn).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('统计人数走 preview 模式，并显示人数', async () => {
    const { container } = render(<EmailBroadcastSection />);
    const user = await fillContent(container);

    await user.click(screen.getByRole('button', { name: /count recipients/i }));

    await waitFor(() => {
      expect(screen.getByText(/eligible recipients: 42/i)).toBeInTheDocument();
    });
    expect(lastCallBody().mode).toBe('preview');
  });

  // 关键闸门：点「开始群发」只是进入确认态，必须再点一次「确认发送」才真发。
  it('必须二次确认才发出 mode=send', async () => {
    const { container } = render(<EmailBroadcastSection />);
    const user = await fillContent(container);
    await user.click(screen.getByRole('button', { name: /count recipients/i }));
    await waitFor(() => screen.getByText(/eligible recipients: 42/i));

    await user.click(screen.getByRole('button', { name: /start broadcast/i }));
    // 第一次点击只切确认态，不该产生新请求
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/send to 42 recipients\? this cannot be undone/i)).toBeInTheDocument();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, mode: 'send', dispatched: 42 }),
    });
    await user.click(screen.getByRole('button', { name: /confirm send/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lastCallBody().mode).toBe('send');
  });

  it('营销总开关关闭时给出警告', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        mode: 'preview',
        recipientCount: 0,
        truncated: false,
        marketingEnabled: false,
      }),
    });

    const { container } = render(<EmailBroadcastSection />);
    const user = await fillContent(container);
    await user.click(screen.getByRole('button', { name: /count recipients/i }));

    await waitFor(() => {
      expect(screen.getByText(/site-wide marketing email switch is off/i)).toBeInTheDocument();
    });
    // 人数为 0 时不该出现群发按钮
    expect(screen.queryByRole('button', { name: /start broadcast/i })).not.toBeInTheDocument();
  });

  it('服务端报错时显示错误文案', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: '按钮链接必须以 http:// 或 https:// 开头' }),
    });

    const { container } = render(<EmailBroadcastSection />);
    const user = await fillContent(container);
    await user.click(screen.getByRole('button', { name: /count recipients/i }));

    await waitFor(() => {
      expect(screen.getByText(/按钮链接必须以/)).toBeInTheDocument();
    });
  });
});
