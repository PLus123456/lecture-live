import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L11：超长文档必须分段渲染。
 * 原实现把整篇渲进一张 canvas —— 浏览器 canvas 有硬上限（iOS Safari 面积仅 ~16.7M px），
 * 超限时画布被静默截断，用户拿到一份后半篇凭空消失的 PDF。
 * 文件名用 .tsx 以命中 vitest 的 jsdom environmentMatchGlobs（需要真 document）。
 */

const { html2canvasMock, addPageMock, addImageMock } = vi.hoisted(() => ({
  html2canvasMock: vi.fn(),
  addPageMock: vi.fn(),
  addImageMock: vi.fn(),
}));

vi.mock('jspdf', () => ({
  default: class {
    addPage = addPageMock;
    addImage = addImageMock;
    output() {
      return new Blob(['pdf']);
    }
  },
}));

vi.mock('html2canvas', () => ({ default: html2canvasMock }));

import { exportPdf } from '@/lib/export/pdf';

/** 画布替身：只需要 width/height，drawImage/toDataURL 由下面的 2d 上下文桩兜住。 */
function fakeCanvas(width: number, height: number) {
  return { width, height };
}

/** 让离屏容器汇报一个指定的布局高度（jsdom 里 scrollHeight 恒为 0）。 */
function stubScrollHeight(px: number) {
  Object.defineProperty(HTMLDivElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return px;
    },
  });
}

const OPTIONS = {
  title: 'T',
  date: '2026-08-01T00:00:00.000Z',
  sourceLang: 'zh',
  targetLang: 'en',
  segments: [],
} as unknown as Parameters<typeof exportPdf>[0];

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  // 真 canvas 在 jsdom 里没有 2d 上下文：给分页用的临时画布打桩
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  })) as unknown as HTMLCanvasElement['getContext'];
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/jpeg;base64,x');
  // 每次调用按请求的裁剪高度返回对应尺寸的画布
  html2canvasMock.mockImplementation(
    async (_el: HTMLElement, opts: { width: number; height: number; scale: number }) =>
      fakeCanvas(
        Math.round(opts.width * opts.scale),
        Math.round(opts.height * opts.scale)
      )
  );
});

describe('exportPdf 分段渲染 (L11)', () => {
  it('短文档只渲一次（与旧实现等价）', async () => {
    stubScrollHeight(900); // < 一页
    await exportPdf(OPTIONS);
    expect(html2canvasMock).toHaveBeenCalledTimes(1);
    expect(addImageMock).toHaveBeenCalledTimes(1);
    expect(addPageMock).not.toHaveBeenCalled();
  });

  it('超长文档拆成多段，每段输出画布都在安全高度内，且各段首尾相接不漏内容', async () => {
    // ~60000 css px ≈ 一小时讲座的转录；×SCALE(2) = 120000 设备像素，
    // 远超任何浏览器的 canvas 上限。
    stubScrollHeight(60_000);
    await exportPdf(OPTIONS);

    const calls = html2canvasMock.mock.calls.map(
      (c) => c[1] as { y: number; height: number; scale: number }
    );
    expect(calls.length).toBeGreaterThan(1);

    for (const opt of calls) {
      // 每段输出画布高度必须在安全上限内
      expect(opt.height * opt.scale).toBeLessThanOrEqual(8192);
    }
    // 段与段首尾相接，且整体覆盖到内容底部（不静默丢内容）
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].y).toBeCloseTo(calls[i - 1].y + calls[i - 1].height, 3);
    }
    const last = calls[calls.length - 1];
    expect(last.y + last.height).toBeCloseTo(60_000, 3);

    // 页数 = ceil(60000 / 一页高度)，每页恰好一张图、addPage 少一次
    const totalPages = addImageMock.mock.calls.length;
    expect(totalPages).toBeGreaterThan(60);
    expect(addPageMock).toHaveBeenCalledTimes(totalPages - 1);
  });
});
