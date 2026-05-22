import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BackgroundTasksIndicator from '@/components/BackgroundTasksIndicator';

vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (state: { token: string | null }) => unknown) =>
    selector({ token: 'test-token' }),
}));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string, params?: Record<string, string | number>) => {
      if (key === 'backgroundTasks.title') return 'Active background tasks';
      if (key === 'backgroundTasks.empty') return 'No active tasks';
      if (key === 'backgroundTasks.runningFor') return `Running for ${params?.time ?? ''}`;
      if (key === 'backgroundTasks.types.report_generation') return 'Generating report';
      if (key === 'backgroundTasks.types.transcribing') return 'Transcribing';
      if (key === 'backgroundTasks.types.finalizing') return 'Finalizing';
      if (key === 'common.close') return 'Close';
      return key;
    },
  }),
}));

describe('BackgroundTasksIndicator', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('当后端返回 0 个任务时不渲染按钮', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        jobs: [],
        finalizingSessions: [],
        asyncTranscribingSessions: [],
        hasActiveTasks: false,
        totalCount: 0,
      }),
    });

    const { container } = render(<BackgroundTasksIndicator />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/user/background-tasks',
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });

    // 没活跃任务时 component 直接返回 null
    expect(container.querySelector('button')).toBeNull();
  });

  it('有任务时显示按钮 + 数字角标，点击展开列出任务', async () => {
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        jobs: [
          {
            id: 'job-1',
            type: 'report_generation',
            status: 'PROCESSING',
            sessionId: 'sess-1',
            sessionTitle: 'My Lecture',
            createdAt,
            startedAt: createdAt,
          },
        ],
        finalizingSessions: [],
        asyncTranscribingSessions: [],
        hasActiveTasks: true,
        totalCount: 1,
      }),
    });

    render(<BackgroundTasksIndicator />);

    const button = await screen.findByRole('button', { name: 'Active background tasks' });
    expect(button).toBeTruthy();
    expect(button.textContent).toContain('1');

    await act(async () => {
      await userEvent.click(button);
    });

    // popover 出现，展示 session title 和 task type
    expect(await screen.findByText('My Lecture')).toBeTruthy();
    expect(screen.getByText(/Generating report/)).toBeTruthy();
  });
});
