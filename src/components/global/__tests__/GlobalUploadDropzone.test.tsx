import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import GlobalUploadDropzone from '@/components/global/GlobalUploadDropzone';

/**
 * 全站拖拽 overlay 的类型门禁。
 *
 * 起因：在文档翻译页（/translate）拖 PDF 会先闪一层"拖放上传转录"的全站 overlay，
 * 文案对不上，而且松手后按非媒体静默忽略，等于白闪一次。
 * 门禁必须与 preventDefault 解耦——非媒体拖拽同样要挡掉浏览器默认行为，
 * 否则用户把 PDF 松手在页面空白处会被浏览器当成导航、直接跳出应用。
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/translate',
}));

vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: { user: { id: string } | null }) => unknown) =>
    selector({ user: { id: 'u1' } }),
}));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

vi.mock('@/stores/toastStore', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/components/global/UploadTranscribeModal', () => ({
  default: () => <div data-testid="upload-modal" />,
}));

type DragItem = { kind: string; type: string };

/** 派发一个带 dataTransfer 的合成拖拽事件（jsdom 没有可用的 DragEvent 构造） */
function fireDrag(type: string, items: DragItem[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], items, files: [] },
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

const PDF: DragItem = { kind: 'file', type: 'application/pdf' };
const AUDIO: DragItem = { kind: 'file', type: 'audio/mpeg' };
const UNKNOWN: DragItem = { kind: 'file', type: '' };

const overlay = () => screen.queryByText('upload.overlayTitle');

describe('GlobalUploadDropzone 的拖拽类型门禁', () => {
  beforeEach(() => {
    render(<GlobalUploadDropzone />);
  });

  it('拖 PDF 不亮上传转录 overlay', () => {
    fireDrag('dragenter', [PDF]);
    expect(overlay()).toBeNull();
  });

  it('拖 PDF 仍然 preventDefault（否则浏览器会导航去打开这个文件）', () => {
    const enter = fireDrag('dragenter', [PDF]);
    expect(enter.defaultPrevented).toBe(true);
    const over = fireDrag('dragover', [PDF]);
    expect(over.defaultPrevented).toBe(true);
  });

  it('拖音频照常亮 overlay', () => {
    fireDrag('dragenter', [AUDIO]);
    expect(overlay()).not.toBeNull();
  });

  it('浏览器识别不出类型时保守放行（drop 分支再兜底提示）', () => {
    fireDrag('dragenter', [UNKNOWN]);
    expect(overlay()).not.toBeNull();
  });

  it('混拖时只要含媒体就亮 overlay', () => {
    fireDrag('dragenter', [PDF, AUDIO]);
    expect(overlay()).not.toBeNull();
  });
});
