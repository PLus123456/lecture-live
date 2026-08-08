import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L5：批量删除后必须按新 total 重算页数并重拉当前页。
 * 原实现只在本地 filter 掉行 + 把 total 减了 deleted，totalPages 留在旧值上：
 * 本页留空洞、后面页的行不上补，删空最后一页后分页器还停在不存在的页码。
 */

vi.mock('@/lib/i18n', async () => {
  const actual = await vi.importActual<typeof import('@/lib/i18n')>('@/lib/i18n');
  return {
    ...actual,
    useI18n: () => ({ t: actual.getTranslation('en'), locale: 'en' }),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: { token: string }) => unknown) =>
    selector({ token: 'tok' }),
}));

import FilesPanel from '@/components/admin/FilesPanel';

const fetchMock = vi.fn();

function makeFile(id: string) {
  return {
    id,
    title: `rec-${id}`,
    status: 'COMPLETED',
    createdAt: '2026-08-01T00:00:00.000Z',
    durationMs: 1000,
    owner: { id: 'u1', email: 'u@example.com', name: 'U' },
    audioSource: 'local',
    canPlayback: false,
    playbackPath: null,
    recordingPath: null,
    transcriptPath: null,
    summaryPath: null,
    reportPath: null,
    courseName: null,
    sizeBytes: 0,
  };
}

/** 记录所有 GET /api/admin/files 请求的 page 参数。 */
function requestedPages(): string[] {
  return fetchMock.mock.calls
    .filter((c) => typeof c[0] === 'string' && c[0].startsWith('/api/admin/files?'))
    .map((c) => new URL(c[0] as string, 'http://x').searchParams.get('page') ?? '');
}

describe('FilesPanel 批量删除后的分页', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('删空第 2 页最后一行 → 重算 totalPages 并回拉第 1 页', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ deleted: 1 }) };
      }
      const page = new URL(url, 'http://x').searchParams.get('page');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          files: page === '2' ? [makeFile('f21')] : [makeFile('f1')],
          pagination: {
            page: Number(page),
            pageSize: 20,
            total: 21,
            totalPages: 2,
          },
        }),
      };
    });

    const user = userEvent.setup();
    render(<FilesPanel />);
    await waitFor(() => expect(requestedPages()).toEqual(['1']));

    // 翻到第 2 页（只剩一行）
    await user.click(screen.getByText('1 / 2').parentElement!.querySelectorAll('button')[1]);
    await waitFor(() => expect(requestedPages()).toEqual(['1', '2']));

    // 全选本页 → 删除 → 确认
    await user.click(screen.getByLabelText('Select all'));
    await user.click(screen.getByRole('button', { name: /delete selected/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^Delete$/i }));

    // 删完 total 21→20、totalPages 2→1，当前页 2 已不存在 → 必须回拉第 1 页。
    // 未修版本这里完全不会再发 GET。
    await waitFor(() => expect(requestedPages()).toEqual(['1', '2', '1']));
  });
});
