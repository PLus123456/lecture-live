import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecordingPicker, {
  filterRecordings,
  toggleSelectAllVisible,
} from '@/components/chat/RecordingPicker';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

vi.mock('@/stores/toastStore', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

const baseItem = (over: Partial<{
  id: string;
  title: string;
  courseName: string | null;
  createdAt: string;
  durationMs: number;
  status: string;
}> = {}) => ({
  id: over.id ?? 'r-1',
  title: over.title ?? 'Lecture 1',
  courseName: over.courseName ?? 'CS101',
  createdAt: over.createdAt ?? '2026-05-01T10:00:00.000Z',
  durationMs: over.durationMs ?? 1_800_000,
  status: over.status ?? 'COMPLETED',
});

describe('filterRecordings', () => {
  const items = [
    baseItem({ id: 'a', title: 'Intro to Algebra', courseName: 'MATH101' }),
    baseItem({ id: 'b', title: 'Calculus Basics', courseName: 'MATH202' }),
    baseItem({ id: 'c', title: 'Linear Algebra', courseName: 'MATH101' }),
    baseItem({ id: 'd', title: 'Quantum 101', courseName: null }),
  ];

  it('空查询返回全部', () => {
    expect(filterRecordings(items, '').map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('按 title 匹配', () => {
    expect(filterRecordings(items, 'algebra').map((r) => r.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('按 courseName 匹配', () => {
    expect(filterRecordings(items, 'math202').map((r) => r.id)).toEqual(['b']);
  });

  it('大小写不敏感 + trim', () => {
    expect(filterRecordings(items, '  CALCULUS  ').map((r) => r.id)).toEqual([
      'b',
    ]);
  });

  it('没匹配时返回空数组', () => {
    expect(filterRecordings(items, 'xyz-not-there')).toEqual([]);
  });

  it('null courseName 不会抛错', () => {
    expect(filterRecordings(items, 'quantum').map((r) => r.id)).toEqual(['d']);
  });
});

describe('toggleSelectAllVisible', () => {
  const visible = [
    baseItem({ id: 'a' }),
    baseItem({ id: 'b' }),
    baseItem({ id: 'c' }),
  ];

  it('空 selected → 选中所有可选项', () => {
    expect(toggleSelectAllVisible([], visible, [])).toEqual(['a', 'b', 'c']);
  });

  it('全部已选 → 反选移除', () => {
    expect(toggleSelectAllVisible(['a', 'b', 'c'], visible, [])).toEqual([]);
  });

  it('部分已选 → 补齐到全选', () => {
    expect(toggleSelectAllVisible(['a'], visible, []).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('alreadyAttached 不计入可选 → 不被加入 selected', () => {
    const result = toggleSelectAllVisible([], visible, ['b']);
    expect(result.sort()).toEqual(['a', 'c']);
  });

  it('alreadyAttached 全部覆盖可见 → 不变', () => {
    const result = toggleSelectAllVisible(['x'], visible, ['a', 'b', 'c']);
    expect(result).toEqual(['x']);
  });

  it('反选仅移除 visible 里的可选项，保留其他 selected', () => {
    const result = toggleSelectAllVisible(
      ['a', 'b', 'c', 'other'],
      visible,
      [],
    );
    expect(result.sort()).toEqual(['other']);
  });
});

describe('RecordingPicker (component)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('open=false 时不渲染任何东西', () => {
    const { container } = render(
      <RecordingPicker
        open={false}
        onClose={() => {}}
        conversationId="conv-1"
        onAttached={() => {}}
      />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('open=true 时拉取 sessions 并仅展示 COMPLETED', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          baseItem({ id: 'done-1', title: '已完成 A', status: 'COMPLETED' }),
          baseItem({ id: 'rec-1', title: '录音中', status: 'RECORDING' }),
          baseItem({ id: 'done-2', title: '已完成 B', status: 'COMPLETED' }),
        ],
        nextCursor: null,
        totalCount: 3,
        totalDurationMs: 0,
      }),
    });

    render(
      <RecordingPicker
        open={true}
        onClose={() => {}}
        conversationId="conv-1"
        onAttached={() => {}}
      />,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/sessions?limit=100',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        }),
      );
    });

    await screen.findByText('已完成 A');
    expect(screen.queryByText('录音中')).toBeNull();
    expect(screen.getByText('已完成 B')).toBeTruthy();
  });

  it('空列表时显示引导，链接到 /home', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [], nextCursor: null, totalCount: 0, totalDurationMs: 0 }),
    });

    render(
      <RecordingPicker
        open={true}
        onClose={() => {}}
        conversationId="conv-1"
        onAttached={() => {}}
      />,
    );

    await screen.findByText('暂无完成的录音，去新建一个吧');
    const link = screen.getByRole('link', { name: /去新建录音/ });
    expect(link.getAttribute('href')).toBe('/home');
  });

  it('alreadyAttached 行被标为"已附加"且不可点选', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          baseItem({ id: 'attached', title: '已挂载录音', status: 'COMPLETED' }),
          baseItem({ id: 'free', title: '可挂载录音', status: 'COMPLETED' }),
        ],
      }),
    });

    render(
      <RecordingPicker
        open={true}
        onClose={() => {}}
        conversationId="conv-1"
        alreadyAttached={['attached']}
        onAttached={() => {}}
      />,
    );

    const attachedRow = await screen.findByTestId('recording-row-attached');
    expect(attachedRow.getAttribute('data-attached')).toBe('true');
    // 行内出现"已附加"标签
    expect(attachedRow.textContent).toContain('已附加');

    // 点击已附加行不会改 selected — footer 按钮保持 disabled
    const user = userEvent.setup();
    await user.click(attachedRow);
    const attachBtn = screen.getByRole('button', { name: /附加选中（0）/ });
    expect((attachBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('Esc 按键关闭 modal', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });

    const onClose = vi.fn();
    render(
      <RecordingPicker
        open={true}
        onClose={onClose}
        conversationId="conv-1"
        onAttached={() => {}}
      />,
    );

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('选中行后 POST 到 /api/conversations/[id]/recordings；成功后调用 onAttached + onClose', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [baseItem({ id: 'r-1', title: '录音 1', status: 'COMPLETED' })],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ added: ['r-1'] }),
    });

    const onAttached = vi.fn();
    const onClose = vi.fn();
    render(
      <RecordingPicker
        open={true}
        onClose={onClose}
        conversationId="conv-99"
        onAttached={onAttached}
      />,
    );

    const row = await screen.findByTestId('recording-row-r-1');
    const user = userEvent.setup();
    await user.click(row);

    const attachBtn = await screen.findByRole('button', {
      name: /附加选中（1）/,
    });
    expect((attachBtn as HTMLButtonElement).disabled).toBe(false);

    await user.click(attachBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversations/conv-99/recordings',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ sessionIds: ['r-1'] }),
        }),
      );
    });

    await waitFor(() => {
      expect(onAttached).toHaveBeenCalledWith(['r-1']);
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('POST 返回 404 时显示错误 toast 且不关闭 modal', async () => {
    const { toast } = await import('@/stores/toastStore');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [baseItem({ id: 'r-1', title: '录音 1', status: 'COMPLETED' })],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
    });

    const onClose = vi.fn();
    const onAttached = vi.fn();
    render(
      <RecordingPicker
        open={true}
        onClose={onClose}
        conversationId="conv-1"
        onAttached={onAttached}
      />,
    );

    const row = await screen.findByTestId('recording-row-r-1');
    const user = userEvent.setup();
    await user.click(row);
    await user.click(
      await screen.findByRole('button', { name: /附加选中（1）/ }),
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onAttached).not.toHaveBeenCalled();
  });

  it('"全选可见" 复选框把所有未附加项加入 selected', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          baseItem({ id: 'a', title: 'A', status: 'COMPLETED' }),
          baseItem({ id: 'b', title: 'B', status: 'COMPLETED' }),
          baseItem({ id: 'c', title: 'C', status: 'COMPLETED' }),
        ],
      }),
    });

    render(
      <RecordingPicker
        open={true}
        onClose={() => {}}
        conversationId="conv-1"
        alreadyAttached={['a']}
        onAttached={() => {}}
      />,
    );

    // 等到列表渲染好
    await screen.findByTestId('recording-row-b');

    const selectAll = screen.getByLabelText('全选可见') as HTMLInputElement;
    const user = userEvent.setup();
    await user.click(selectAll);

    // attached 'a' 不计入，所以选中应该是 2 项
    await screen.findByRole('button', { name: /附加选中（2）/ });
  });
});
