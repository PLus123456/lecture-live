'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useTranslationStore } from '@/stores/translationStore';
import { useSettingsStore } from '@/stores/settingsStore';

const LANG_NAMES: Record<string, string> = {
  en: 'English', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  fr: 'French', de: 'German', es: 'Spanish', pt: 'Portuguese',
  it: 'Italian', ru: 'Russian', ar: 'Arabic', hi: 'Hindi',
  th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', tr: 'Turkish',
  pl: 'Polish', nl: 'Dutch', sv: 'Swedish', da: 'Danish',
  fi: 'Finnish', no: 'Norwegian', uk: 'Ukrainian', cs: 'Czech',
  ro: 'Romanian', hu: 'Hungarian', el: 'Greek', bg: 'Bulgarian',
  he: 'Hebrew', ms: 'Malay', tl: 'Filipino',
};

/** Document PiP API 类型声明（仅 Chrome 116+ 支持） */
interface DocumentPictureInPicture {
  window?: Window | null;
  requestWindow(options?: {
    width?: number;
    height?: number;
    disallowReturnToOpener?: boolean;
    preferInitialWindowPlacement?: boolean;
  }): Promise<Window>;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

const PIP_WIDTH = 420;
const PIP_HEIGHT = 320;

function isTopLevelWindow(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    return window.top === window;
  } catch {
    return false;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- webkit 前缀 API 无标准类型定义 */

/** 检测浏览器是否支持 Video Element PiP（Safari / iOS Safari） */
function supportsVideoPip(): boolean {
  if (typeof document === 'undefined') return false;
  const video = document.createElement('video');
  const canvas = document.createElement('canvas');

  // 标准 PiP API 或 webkit 前缀 API（iOS Safari）
  const hasPipApi = typeof video.requestPictureInPicture === 'function'
    || typeof (video as any).webkitSetPresentationMode === 'function';

  const hasExitPip = typeof document.exitPictureInPicture === 'function'
    || typeof (document as any).webkitExitPictureInPicture === 'function';

  // captureStream 或 webkit 前缀
  const hasCaptureStream = typeof canvas.captureStream === 'function'
    || typeof (canvas as any).webkitCaptureStream === 'function';

  return hasPipApi && hasExitPip && hasCaptureStream;
}

/** 获取 canvas 的 captureStream（兼容 webkit 前缀） */
function getCaptureStream(canvas: HTMLCanvasElement, fps: number): MediaStream | null {
  if (typeof canvas.captureStream === 'function') {
    return canvas.captureStream(fps);
  }
  if (typeof (canvas as any).webkitCaptureStream === 'function') {
    return (canvas as any).webkitCaptureStream(fps);
  }
  return null;
}

/** 请求 Video PiP（兼容标准 API 和 webkit 前缀） */
async function requestVideoPip(video: HTMLVideoElement): Promise<void> {
  // 优先使用标准 API
  if (typeof video.requestPictureInPicture === 'function') {
    await video.requestPictureInPicture();
    return;
  }
  // iOS Safari webkit 前缀
  if (typeof (video as any).webkitSetPresentationMode === 'function') {
    (video as any).webkitSetPresentationMode('picture-in-picture');
    return;
  }
  throw new Error('No PiP API available');
}

/** 退出 Video PiP（兼容标准 API 和 webkit 前缀） */
function exitVideoPip(): void {
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  } else if ((document as any).webkitExitPictureInPicture) {
    try { (document as any).webkitExitPictureInPicture(); } catch { /* ignore */ }
  }
}


/* eslint-enable @typescript-eslint/no-explicit-any */

/** 判断最佳 PiP 策略：Document PiP > Video PiP > 页内悬浮 */
function getPreferredPipStrategy(): {
  strategy: 'document-pip' | 'video-pip' | 'inline';
  reason: string;
} {
  if (typeof window === 'undefined') {
    return { strategy: 'inline', reason: 'window-unavailable' };
  }

  // Chrome 116+: Document PiP（最佳，支持完整交互）
  if (window.documentPictureInPicture?.requestWindow
    && window.isSecureContext
    && isTopLevelWindow()) {
    return { strategy: 'document-pip', reason: 'document-pip-available' };
  }

  // Safari: Video Element PiP（系统级画中画，只读）
  if (supportsVideoPip()) {
    return { strategy: 'video-pip', reason: 'video-pip-available' };
  }

  return { strategy: 'inline', reason: 'fallback-inline' };
}

/**
 * 初始化弹出窗口的 DOM：注入样式 + 创建挂载点
 */
function bootstrapPipWindow(win: Window) {
  // 设置标题
  win.document.title = 'Reference Tool — Translation';

  // 注入样式
  const style = win.document.createElement('style');
  style.textContent = PIP_STYLES;
  win.document.head.appendChild(style);

  // 创建 React 挂载点
  let mountEl = win.document.getElementById('pip-root');
  if (!mountEl) {
    mountEl = win.document.createElement('div');
    mountEl.id = 'pip-root';
    win.document.body.appendChild(mountEl);
  }
}

/**
 * 画中画参考工具 — 跨浏览器支持
 *
 * - Chrome 116+：使用 Document Picture-in-Picture API（原生画中画体验）
 * - Safari / Firefox / 其它：页内可拖拽悬浮面板（InlinePipPanel）
 */
export function usePipReferenceTool() {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [mode, setMode] = useState<'document-pip' | 'video-pip' | 'inline' | null>(null);

  const handleWindowClosed = useCallback(() => {
    setPipWindow(null);
    setIsOpen(false);
    setMode(null);
  }, []);

  // ── Video PiP 子系统（Safari）——
  const videoPip = useVideoPip(handleWindowClosed);

  // ── Document PiP 路径（Chrome 116+）──
  const openDocPip = useCallback(async (): Promise<boolean> => {
    try {
      try {
        const existingPip = window.documentPictureInPicture?.window;
        if (existingPip && !existingPip.closed) {
          console.info('[PiP] Closing stale Document PiP window before opening new one');
          existingPip.close();
          await new Promise(r => setTimeout(r, 100));
        }
      } catch { /* ignore */ }

      const pip = await window.documentPictureInPicture!.requestWindow({
        width: PIP_WIDTH,
        height: PIP_HEIGHT,
        preferInitialWindowPlacement: true,
      });

      bootstrapPipWindow(pip);
      pip.addEventListener('pagehide', handleWindowClosed);

      try { pip.focus(); } catch { /* ignore */ }

      setPipWindow(pip);
      setIsOpen(true);
      setMode('document-pip');
      console.info('[PiP] Document PiP opened successfully');
      return true;
    } catch (err) {
      console.error('[PiP] Document PiP failed:', {
        err,
        message: err instanceof Error ? err.message : String(err),
        isSecureContext: window.isSecureContext,
        isTopLevel: isTopLevelWindow(),
        hasDocumentPictureInPicture: Boolean(window.documentPictureInPicture),
      });
      return false;
    }
  }, [handleWindowClosed]);

  // ── Video PiP 路径（Safari）──
  const openVideoPip = useCallback(async (): Promise<boolean> => {
    return videoPip.open();
  }, [videoPip]);

  // ── Inline 路径（Firefox / 其它）——页内悬浮面板 ──
  const openInline = useCallback(() => {
    setIsOpen(true);
    setMode('inline');
    console.info('[PiP] Inline floating panel opened');
  }, []);

  const open = useCallback(() => {
    const { strategy, reason } = getPreferredPipStrategy();
    console.info('[PiP] Strategy:', strategy, 'Reason:', reason);

    if (strategy === 'inline') {
      openInline();
      return;
    }

    if (strategy === 'video-pip') {
      void openVideoPip().then((opened) => {
        if (opened) {
          setIsOpen(true);
          setMode('video-pip');
          return;
        }
        console.warn('[PiP] Video PiP failed, falling back to inline panel');
        openInline();
      }).catch(() => {
        openInline();
      });
      return;
    }

    void openDocPip().then((opened) => {
      if (opened) return;
      // Document PiP 失败时尝试 Video PiP
      if (supportsVideoPip()) {
        console.warn('[PiP] Document PiP failed, trying Video PiP');
        return openVideoPip().then((ok) => {
          if (ok) {
            setIsOpen(true);
            setMode('video-pip');
            return;
          }
          openInline();
        });
      }
      console.warn('[PiP] Document PiP failed, falling back to inline panel');
      openInline();
    }).catch(() => {
      console.warn('[PiP] Unexpected error, trying inline fallback');
      openInline();
    });
  }, [openDocPip, openVideoPip, openInline]);

  const close = useCallback(() => {
    if (mode === 'document-pip') {
      try { pipWindow?.close(); } catch { /* ignore */ }
      setPipWindow(null);
    } else if (mode === 'video-pip') {
      videoPip.close();
    }
    setIsOpen(false);
    setMode(null);
  }, [pipWindow, mode, videoPip]);

  const toggle = useCallback(() => {
    if (isOpen) close();
    else open();
  }, [isOpen, open, close]);

  // 仅在 pipWindow 变更或组件卸载时清理 Document PiP
  // Video PiP 的清理由 useVideoPip 内部 useEffect 管理
  // 注意：不能将 videoPip 放入 deps，否则因每次渲染 videoPip 对象引用变化
  //       导致 cleanup 反复执行 pipWindow?.close()，Document PiP 会立即关闭
  useEffect(() => {
    return () => {
      try { pipWindow?.close(); } catch { /* ignore */ }
    };
  }, [pipWindow]);

  return { pipWindow, isOpen, pinned, setPinned, mode, open, close, toggle, videoPipUpdate: videoPip.updateData };
}

// ═══════════════════════════════════════════════════════════════════════
// Safari Video PiP — Canvas 渲染器
// 用高 DPI Canvas 绘制与原版 PiP 完全一致的界面，再通过 captureStream
// 输出到 <video> 元素，调用 requestPictureInPicture() 实现系统级画中画
// ═══════════════════════════════════════════════════════════════════════

/** 设计色板 — 与 PIP_STYLES 完全一致 */
const COLORS = {
  bg: '#fffdf9',
  border: '#e8dfd6',
  headerBorder: '#ede6dd',
  rust: '#9b4e2c',
  charcoal: '#3d3631',
  charcoalLight: '#6b5d52',
  muted: '#b8ada2',
  mutedLight: '#a09388',
  divider: '#ede6dd',
  footerBg: '#fffdf9',
  iconBg: '#f5ede5',
} as const;

const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/**
 * Canvas 文字自动换行（支持 CJK 字符逐字换行）
 * 返回每行文字数组和总行数
 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  if (!text) return [];
  const lines: string[] = [];
  let line = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const testLine = line + ch;
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && line.length > 0) {
      lines.push(line);
      line = ch;
    } else {
      line = testLine;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * 在 Canvas 上绘制完整的 PiP 界面
 * 完全复刻 PIP_STYLES 中的布局和视觉效果
 */
function renderPipCanvas(
  canvas: HTMLCanvasElement,
  data: {
    srcName: string;
    tgtName: string;
    recentSourceText: string;
    recentTargetText: string;
    hasTranslation: boolean;
  },
) {
  const dpr = window.devicePixelRatio || 2;
  const w = PIP_WIDTH;
  const h = PIP_HEIGHT;

  // 设置高 DPI canvas
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }

  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const margin = 6; // 外边距（对应 .pip-container margin: 6px）
  const radius = 12;
  const innerX = margin;
  const innerY = margin;
  const innerW = w - margin * 2;
  const innerH = h - margin * 2;

  // ── 背景 ──
  ctx.fillStyle = '#f5f0eb';
  ctx.fillRect(0, 0, w, h);

  // ── 圆角容器 ──
  ctx.beginPath();
  ctx.roundRect(innerX, innerY, innerW, innerH, radius);
  ctx.fillStyle = COLORS.bg;
  ctx.fill();
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.stroke();

  const padX = 14; // padding 水平
  const contentX = innerX + padX;
  const contentW = innerW - padX * 2;

  // ── Header（高度 40px，对应 padding 10px 上下 + 内容） ──
  const headerH = 40;
  const headerY = innerY;

  // Header 底部分割线
  ctx.beginPath();
  ctx.moveTo(innerX, headerY + headerH);
  ctx.lineTo(innerX + innerW, headerY + headerH);
  ctx.strokeStyle = COLORS.headerBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Header 图标（翻译图标 — 简化绘制为文字替代）
  const headerCenterY = headerY + headerH / 2;
  ctx.fillStyle = COLORS.rust;
  ctx.font = `bold 14px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  // 小翻译图标用文字 "文A" 模拟
  ctx.font = `600 12px ${FONT_FAMILY}`;
  ctx.fillText('文A', contentX, headerCenterY);

  // Header 标题
  ctx.fillStyle = COLORS.rust;
  ctx.font = `700 11px ${FONT_FAMILY}`;
  ctx.letterSpacing = '0.08em';
  ctx.fillText('REFERENCE TOOL', contentX + 28, headerCenterY);
  ctx.letterSpacing = '0px';

  // ── Footer（高度 36px） ──
  const footerH = 36;
  const footerY = innerY + innerH - footerH;

  // Footer 顶部分割线
  ctx.beginPath();
  ctx.moveTo(innerX, footerY);
  ctx.lineTo(innerX + innerW, footerY);
  ctx.strokeStyle = COLORS.headerBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Footer 按钮文字
  ctx.fillStyle = COLORS.rust;
  ctx.font = `600 10px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = '0.06em';
  const footerCenterY = footerY + footerH / 2;
  // 右对齐
  const copyText = '⧉ COPY';
  const listenText = '🔊 LISTEN';
  const listenW = ctx.measureText(listenText).width;
  const copyW = ctx.measureText(copyText).width;
  ctx.fillText(listenText, innerX + innerW - padX - listenW, footerCenterY);
  ctx.fillText(copyText, innerX + innerW - padX - listenW - 16 - copyW, footerCenterY);
  ctx.letterSpacing = '0px';

  // ── 内容区 ──
  const contentTop = headerY + headerH + 8;
  const contentBottom = footerY - 8;
  const contentHeight = contentBottom - contentTop;

  if (!data.recentSourceText && !data.recentTargetText) {
    // 空状态
    ctx.fillStyle = COLORS.muted;
    ctx.font = `italic 13px ${FONT_FAMILY}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for transcript...', w / 2, contentTop + contentHeight / 2);
    ctx.textAlign = 'left';
    return;
  }

  // 计算源语言和目标语言区域高度分配
  let srcAreaH: number;
  let tgtAreaH: number;
  const dividerH = data.hasTranslation ? 13 : 0; // 分割线 + margin

  if (data.hasTranslation) {
    // flex: 2 / flex: 3 比例
    srcAreaH = (contentHeight - dividerH) * 0.4;
    tgtAreaH = (contentHeight - dividerH) * 0.6;
  } else {
    srcAreaH = contentHeight;
    tgtAreaH = 0;
  }

  // ── 源语言区域 ──
  let cursorY = contentTop;

  // 源语言标签
  ctx.fillStyle = COLORS.charcoalLight;
  ctx.font = `700 9px ${FONT_FAMILY}`;
  ctx.textBaseline = 'top';
  ctx.letterSpacing = '0.1em';
  ctx.fillText(data.srcName, contentX, cursorY);
  ctx.letterSpacing = '0px';
  cursorY += 15;

  // 源语言文本 — 带渐隐遮罩效果（从底部向上显示最新内容）
  ctx.save();
  ctx.beginPath();
  ctx.rect(contentX, cursorY, contentW, srcAreaH - 15);
  ctx.clip();

  ctx.fillStyle = COLORS.charcoalLight;
  ctx.font = `400 12px/${1.55} ${FONT_FAMILY}`;
  ctx.font = `400 12px ${FONT_FAMILY}`;
  const srcLines = wrapText(ctx, data.recentSourceText, contentW);
  const srcLineH = 12 * 1.55;
  const srcMaxLines = Math.floor((srcAreaH - 15) / srcLineH);
  // 只显示最后几行（模拟 scrollTop = scrollHeight 效果）
  const srcVisibleLines = srcLines.slice(-srcMaxLines);

  // 渐隐遮罩：顶部行透明度递增
  const fadeLines = Math.min(2, srcVisibleLines.length);
  for (let i = 0; i < srcVisibleLines.length; i++) {
    const alpha = i < fadeLines ? (i + 1) / (fadeLines + 1) : 1;
    ctx.globalAlpha = alpha;
    ctx.fillText(
      srcVisibleLines[i],
      contentX,
      cursorY + i * srcLineH,
    );
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  if (!data.hasTranslation) return;

  // ── 分割线 ──
  const dividerY = contentTop + srcAreaH + 6;
  ctx.beginPath();
  ctx.moveTo(contentX, dividerY);
  ctx.lineTo(contentX + contentW, dividerY);
  ctx.strokeStyle = COLORS.divider;
  ctx.lineWidth = 1;
  ctx.stroke();

  // ── 目标语言区域 ──
  const tgtStartY = dividerY + 7;

  // 目标语言标签
  ctx.fillStyle = COLORS.rust;
  ctx.font = `700 9px ${FONT_FAMILY}`;
  ctx.textBaseline = 'top';
  ctx.letterSpacing = '0.1em';
  ctx.fillText(data.tgtName, contentX, tgtStartY);
  ctx.letterSpacing = '0px';
  const tgtTextY = tgtStartY + 15;

  // 目标语言文本
  ctx.save();
  ctx.beginPath();
  ctx.rect(contentX, tgtTextY, contentW, tgtAreaH - 15);
  ctx.clip();

  if (data.recentTargetText) {
    ctx.fillStyle = COLORS.rust;
    ctx.font = `500 17px ${FONT_FAMILY}`;
    const tgtLines = wrapText(ctx, data.recentTargetText, contentW);
    const tgtLineH = 17 * 1.5;
    const tgtMaxLines = Math.floor((tgtAreaH - 15) / tgtLineH);
    const tgtVisibleLines = tgtLines.slice(-tgtMaxLines);

    const fadeLinesT = Math.min(2, tgtVisibleLines.length);
    for (let i = 0; i < tgtVisibleLines.length; i++) {
      const alpha = i < fadeLinesT ? (i + 1) / (fadeLinesT + 1) : 1;
      ctx.globalAlpha = alpha;
      ctx.fillText(
        tgtVisibleLines[i],
        contentX,
        tgtTextY + i * tgtLineH,
      );
    }
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `italic 400 17px ${FONT_FAMILY}`;
    ctx.fillText('Translating...', contentX, tgtTextY);
  }
  ctx.restore();
}

/**
 * Safari Video PiP Hook — 管理 Canvas → Video → PiP 生命周期
 *
 * 关键设计：挂载时「预热」video 元素
 * iOS Safari 要求 requestPictureInPicture() 在用户手势上下文内同步调用，
 * 但如果 video 还没有可用帧（readyState < HAVE_CURRENT_FRAME）则会被拒绝。
 * 预热方案：挂载时即创建 canvas → captureStream → video.play()，
 * 这样用户点击 PiP 按钮时 video 已有数据，可直接进入画中画。
 */
function useVideoPip(onClosed: () => void) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number>(0);
  const warmedUpRef = useRef(false);
  const dataRef = useRef<Parameters<typeof renderPipCanvas>[1]>({
    srcName: '', tgtName: '', recentSourceText: '', recentTargetText: '', hasTranslation: false,
  });

  // 确保 canvas 和 video 元素存在（懒创建，隐藏在 DOM 中）
  const ensureElements = useCallback(() => {
    if (!canvasRef.current) {
      const canvas = document.createElement('canvas');
      canvas.style.position = 'fixed';
      canvas.style.left = '-9999px';
      canvas.style.top = '-9999px';
      canvas.style.pointerEvents = 'none';
      canvas.style.opacity = '0';
      document.body.appendChild(canvas);
      canvasRef.current = canvas;
    }
    if (!videoRef.current) {
      const video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      // 注意：不设置 autopictureinpicture，避免页面切后台时自动进入 PiP
      video.muted = true;
      video.autoplay = true;
      video.style.position = 'fixed';
      video.style.left = '-9999px';
      video.style.top = '-9999px';
      // iOS Safari 需要视频元素有合理的尺寸才能开启系统级 PiP
      video.style.width = `${PIP_WIDTH}px`;
      video.style.height = `${PIP_HEIGHT}px`;
      video.style.opacity = '0.01'; // iOS 对 opacity:0 的元素可能跳过渲染
      video.style.pointerEvents = 'none';
      document.body.appendChild(video);
      videoRef.current = video;
    }
    return { canvas: canvasRef.current, video: videoRef.current };
  }, []);

  // ── 预热：挂载时创建元素、渲染一帧、启动流并播放 ──
  // 使 video.readyState >= HAVE_CURRENT_FRAME，确保后续 PiP 请求不会因缺数据被拒
  useEffect(() => {
    if (!supportsVideoPip() || warmedUpRef.current) return;
    warmedUpRef.current = true;
    const { canvas, video } = ensureElements();
    renderPipCanvas(canvas, dataRef.current);
    const stream = getCaptureStream(canvas, 5); // 低帧率预热，节省资源
    if (stream) {
      video.srcObject = stream;
      video.play().catch(() => { /* 静音自动播放一般不会被阻止 */ });
    }
  }, [ensureElements]);

  // 启动渲染循环（PiP 打开后全速渲染）
  const startRenderLoop = useCallback(() => {
    // 先取消已有循环，防止重复
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const render = () => {
      if (canvasRef.current) {
        renderPipCanvas(canvasRef.current, dataRef.current);
      }
      rafRef.current = requestAnimationFrame(render);
    };
    rafRef.current = requestAnimationFrame(render);
  }, []);

  const stopRenderLoop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  // 打开 Video PiP
  const open = useCallback(async (): Promise<boolean> => {
    try {
      const { canvas, video } = ensureElements();

      // 渲染最新一帧
      renderPipCanvas(canvas, dataRef.current);

      // 如果流已断开（首次打开或 close 后仍保留），重新连接
      if (!video.srcObject) {
        const stream = getCaptureStream(canvas, 30);
        if (!stream) {
          console.error('[PiP] captureStream not available');
          return false;
        }
        video.srcObject = stream;
      }

      // 确保 video 正在播放（预热阶段可能已在播放）
      if (video.paused) {
        // 不 await —— 保持用户手势上下文存活
        video.play().catch(() => {});
      }

      // 在用户手势栈内立即请求 PiP
      try {
        await requestVideoPip(video);
      } catch (pipErr) {
        // 部分 Safari / iOS 版本要求 video 处于播放且有可用帧，
        // 等 play 完成 + 一帧渲染后再重试
        console.warn('[PiP] First PiP attempt failed, retrying:', pipErr);
        if (video.paused) {
          await video.play();
        }
        // 等待一帧，让 canvas 数据通过 stream 到达 video
        await new Promise<void>(r => requestAnimationFrame(() => r()));
        await requestVideoPip(video);
      }

      // 监听 PiP 退出（标准事件 + webkit 事件）
      video.addEventListener('leavepictureinpicture', onClosed, { once: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      video.addEventListener('webkitpresentationmodechanged', function handler(this: HTMLVideoElement) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((this as any).webkitPresentationMode !== 'picture-in-picture') {
          onClosed();
          this.removeEventListener('webkitpresentationmodechanged', handler);
        }
      });

      startRenderLoop();
      console.info('[PiP] Video PiP opened successfully');
      return true;
    } catch (err) {
      console.error('[PiP] Video PiP failed:', err);
      return false;
    }
  }, [ensureElements, startRenderLoop, onClosed]);

  // 关闭 Video PiP
  const close = useCallback(() => {
    stopRenderLoop();
    try {
      exitVideoPip();
      // webkit 前缀：将展示模式改回 inline
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (videoRef.current && typeof (videoRef.current as any).webkitSetPresentationMode === 'function') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (videoRef.current as any).webkitSetPresentationMode('inline');
      }
    } catch { /* ignore */ }
    // 保留 video.srcObject 不销毁 —— 下次 open 时可快速重用，
    // 避免重新创建流和等待 video 加载数据
  }, [stopRenderLoop]);

  // 更新渲染数据（由外部 bridge 组件调用）
  const updateData = useCallback((data: Parameters<typeof renderPipCanvas>[1]) => {
    dataRef.current = data;
  }, []);

  // 组件卸载时完全清理
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      try { exitVideoPip(); } catch { /* ignore */ }
      if (canvasRef.current) {
        canvasRef.current.remove();
        canvasRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
        videoRef.current.remove();
        videoRef.current = null;
      }
    };
  }, []);

  return useMemo(() => ({ open, close, updateData }), [open, close, updateData]);
}

/**
 * 共享的流式内容数据 hook
 */
function usePipContentData() {
  const segments = useTranscriptStore((s) => s.segments);
  const currentPreview = useTranscriptStore((s) => s.currentPreview);
  const currentPreviewTranslation = useTranscriptStore((s) => s.currentPreviewTranslation);
  const translations = useTranslationStore((s) => s.translations);
  const sourceLang = useSettingsStore((s) => s.sourceLang);
  const targetLang = useSettingsStore((s) => s.targetLang);

  const recentSourceText = useMemo(() => {
    const parts: string[] = [];
    const tail = segments.slice(-6);
    for (const seg of tail) parts.push(seg.text);
    if (currentPreview) parts.push(currentPreview);
    return parts.join(' ');
  }, [segments, currentPreview]);

  const recentTargetText = useMemo(() => {
    if (!targetLang) return '';
    const parts: string[] = [];
    const tail = segments.slice(-6);
    for (const seg of tail) {
      const t = translations[seg.id];
      if (t) parts.push(t);
    }
    if (currentPreviewTranslation) parts.push(currentPreviewTranslation);
    return parts.join(' ');
  }, [segments, translations, targetLang, currentPreviewTranslation]);

  const hasTranslation = !!targetLang;
  const srcName = (LANG_NAMES[sourceLang] || sourceLang || 'Source').toUpperCase();
  const tgtName = (LANG_NAMES[targetLang] || targetLang || 'Target').toUpperCase();

  return { segments, translations, sourceLang, targetLang, hasTranslation, srcName, tgtName, recentSourceText, recentTargetText };
}

/** 共享的 PiP 内容 JSX（Header + Stream Content + Footer） */
function PipContent({
  pinned, onTogglePin, onClose, dragHandleProps,
}: {
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>;
}) {
  const { segments, translations, sourceLang, targetLang, hasTranslation, srcName, tgtName, recentSourceText, recentTargetText } = usePipContentData();
  const srcScrollRef = useRef<HTMLDivElement | null>(null);
  const tgtScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (srcScrollRef.current) srcScrollRef.current.scrollTop = srcScrollRef.current.scrollHeight;
    if (tgtScrollRef.current) tgtScrollRef.current.scrollTop = tgtScrollRef.current.scrollHeight;
  }, [recentSourceText, recentTargetText]);

  return (
    <>
      {/* Header — 可拖拽区域 */}
      <div className="pip-header" {...dragHandleProps}>
        <div className="pip-header-left">
          <svg className="pip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 8 6 6" /><path d="m4 14 6 6" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" />
          </svg>
          <span className="pip-title">REFERENCE TOOL</span>
        </div>
        <div className="pip-header-right">
          <button className={`pip-pin-btn ${pinned ? 'pinned' : ''}`} onClick={onTogglePin} title={pinned ? 'Unpin' : 'Pin on top'}>
            <svg viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
              <line x1="12" y1="17" x2="12" y2="22" /><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
            </svg>
          </button>
          <button className="pip-close-btn" onClick={onClose} title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* 流式内容区 */}
      <div className="pip-stream-content">
        {!recentSourceText && !recentTargetText ? (
          <div className="pip-empty">Waiting for transcript...</div>
        ) : (
          <>
            <div className="pip-lang-section pip-source-section">
              <div className="pip-lang-label pip-source-label">{srcName}</div>
              <div className="pip-lang-text-wrap pip-source-wrap" ref={srcScrollRef}>
                <p className="pip-source-text">{recentSourceText}</p>
              </div>
            </div>

            {hasTranslation && <div className="pip-divider" />}

            {hasTranslation && (
              <div className="pip-lang-section pip-target-section">
                <div className="pip-lang-label pip-target-label">{tgtName}</div>
                <div className="pip-lang-text-wrap pip-target-wrap" ref={tgtScrollRef}>
                  {recentTargetText ? (
                    <p className="pip-target-text">{recentTargetText}</p>
                  ) : (
                    <p className="pip-target-text translating">Translating...</p>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="pip-footer">
        <button className="pip-footer-btn" onClick={() => {
          const lastSeg = segments[segments.length - 1];
          if (!lastSeg) return;
          const text = hasTranslation && translations[lastSeg.id]
            ? `${lastSeg.text}\n\n${translations[lastSeg.id]}`
            : lastSeg.text;
          navigator.clipboard.writeText(text).catch(() => {});
        }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
          COPY
        </button>
        <button className="pip-footer-btn" onClick={() => {
          const lastSeg = segments[segments.length - 1];
          const text = hasTranslation && translations[lastSeg?.id]
            ? translations[lastSeg.id]
            : lastSeg?.text;
          if (text && 'speechSynthesis' in window) {
            const utter = new SpeechSynthesisUtterance(text);
            utter.lang = hasTranslation ? targetLang : sourceLang;
            speechSynthesis.speak(utter);
          }
        }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
          LISTEN
        </button>
      </div>
    </>
  );
}

/**
 * Document PiP Portal — Chrome 116+ 专用
 */
export function PipPortal({
  pipWindow,
  pinned,
  onTogglePin,
  onClose,
}: {
  pipWindow: Window;
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
}) {
  const mountEl = pipWindow.document.getElementById('pip-root');
  if (!mountEl) return null;

  return createPortal(
    <div className="pip-container">
      <PipContent pinned={pinned} onTogglePin={onTogglePin} onClose={onClose} />
    </div>,
    mountEl,
  );
}

/**
 * 页内悬浮面板 — Safari / Firefox / 不支持 Document PiP 的浏览器
 * 支持拖拽移动
 */
export function InlinePipPanel({
  pinned,
  onTogglePin,
  onClose,
}: {
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [pos, setPos] = useState({ x: -1, y: -1 });

  // 初始化位置：右下角
  useEffect(() => {
    if (pos.x === -1) {
      setPos({
        x: window.innerWidth - PIP_WIDTH - 24,
        y: window.innerHeight - PIP_HEIGHT - 24,
      });
    }
  }, [pos.x]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // 不拦截按钮点击
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
  }, [pos]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    setPos({
      x: Math.max(0, Math.min(window.innerWidth - PIP_WIDTH, dragState.current.origX + dx)),
      y: Math.max(0, Math.min(window.innerHeight - PIP_HEIGHT, dragState.current.origY + dy)),
    });
  }, []);

  const onPointerUp = useCallback(() => {
    dragState.current = null;
  }, []);

  const dragHandleProps: React.HTMLAttributes<HTMLDivElement> = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    style: { cursor: 'grab', touchAction: 'none' },
  };

  // 注入 scoped 样式（仅一次）
  useEffect(() => {
    const STYLE_ID = 'pip-inline-styles';
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = INLINE_PIP_STYLES;
    document.head.appendChild(style);
    return () => {
      // 不移除 — 可能有多个实例，且样式本身是幂等的
    };
  }, []);

  return (
    <div
      ref={panelRef}
      className="pip-inline-panel"
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: PIP_WIDTH,
        height: PIP_HEIGHT,
        zIndex: 9999,
      }}
    >
      <PipContent pinned={pinned} onTogglePin={onTogglePin} onClose={onClose} dragHandleProps={dragHandleProps} />
    </div>
  );
}

/**
 * Video PiP 数据桥接组件 — 在 video-pip 模式下渲染，
 * 从 Zustand store 读取转录/翻译数据并推送到 Canvas 渲染器
 */
export function VideoPipBridge({ updateData }: { updateData: (data: Parameters<typeof renderPipCanvas>[1]) => void }) {
  const { srcName, tgtName, recentSourceText, recentTargetText, hasTranslation } = usePipContentData();

  useEffect(() => {
    updateData({ srcName, tgtName, recentSourceText, recentTargetText, hasTranslation });
  }, [srcName, tgtName, recentSourceText, recentTargetText, hasTranslation, updateData]);

  return null; // 纯数据桥接，不渲染任何 DOM
}

/** PiP 窗口内的样式 — 与截图参考风格一致，兼容所有浏览器 */
const PIP_STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f5f0eb;
    color: #3d3631;
    overflow: hidden;
  }
  #pip-root { display: flex; flex-direction: column; height: 100vh; }

  .pip-container {
    display: flex; flex-direction: column; height: 100%;
    background: #fffdf9;
    border: 1px solid #e8dfd6;
    border-radius: 12px;
    margin: 6px;
    overflow: hidden;
    box-shadow: 0 4px 24px rgba(0,0,0,0.08);
  }

  /* Header */
  .pip-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid #ede6dd;
    flex-shrink: 0;
  }
  .pip-header-left { display: flex; align-items: center; gap: 8px; }
  .pip-icon { width: 16px; height: 16px; color: #9b4e2c; }
  .pip-title {
    font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
    color: #9b4e2c; text-transform: uppercase;
  }
  .pip-header-right { display: flex; align-items: center; gap: 4px; }
  .pip-pin-btn, .pip-close-btn {
    width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
    border: none; background: transparent; color: #a09388; cursor: pointer;
    border-radius: 6px; transition: all 0.15s;
  }
  .pip-pin-btn:hover, .pip-close-btn:hover { background: #f0e8df; color: #6b5d52; }
  .pip-pin-btn.pinned { color: #9b4e2c; }

  /* 流式内容区 */
  .pip-stream-content {
    flex: 1; display: flex; flex-direction: column;
    padding: 8px 14px; overflow: hidden; gap: 0;
  }

  .pip-empty {
    height: 100%; display: flex; align-items: center; justify-content: center;
    color: #b8ada2; font-size: 13px; font-style: italic;
  }

  /* 语言分区 */
  .pip-lang-section {
    display: flex; flex-direction: column; min-height: 0;
  }
  .pip-source-section { flex: 2; }
  .pip-target-section { flex: 3; }

  .pip-lang-label {
    font-size: 9px; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; margin-bottom: 4px; flex-shrink: 0;
  }
  .pip-source-label { color: #6b5d52; }
  .pip-target-label { color: #9b4e2c; }

  /* 文本滚动容器 — 只显示最新 3-4 行，溢出后自动滚到底部 */
  .pip-lang-text-wrap {
    flex: 1; overflow-y: auto; scroll-behavior: smooth;
    mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 100%);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 100%);
  }
  .pip-lang-text-wrap::-webkit-scrollbar { width: 3px; }
  .pip-lang-text-wrap::-webkit-scrollbar-thumb { background: #d9d0c6; border-radius: 3px; }
  .pip-lang-text-wrap { scrollbar-width: thin; scrollbar-color: #d9d0c6 transparent; }

  .pip-source-text {
    font-size: 12px; line-height: 1.55; color: #6b5d52;
    margin: 0;
  }

  .pip-target-text {
    font-size: 17px; line-height: 1.5; color: #9b4e2c;
    font-weight: 500; margin: 0;
  }
  .pip-target-text.translating {
    color: #b8ada2; font-style: italic; font-weight: 400;
  }

  .pip-divider {
    height: 1px; background: #ede6dd; flex-shrink: 0;
    margin: 6px 0;
  }

  /* Footer */
  .pip-footer {
    display: flex; justify-content: flex-end; gap: 6px;
    padding: 8px 14px;
    border-top: 1px solid #ede6dd;
    flex-shrink: 0;
  }
  .pip-footer-btn {
    display: flex; align-items: center; gap: 4px;
    padding: 5px 10px; border-radius: 6px;
    border: none; background: transparent;
    font-size: 10px; font-weight: 600; letter-spacing: 0.06em;
    color: #9b4e2c; cursor: pointer; text-transform: uppercase;
    transition: background 0.15s;
  }
  .pip-footer-btn:hover { background: #f5ede5; }
`;

/** 页内悬浮面板样式 — 所有选择器 scope 到 .pip-inline-panel 下 */
const INLINE_PIP_STYLES = `
  .pip-inline-panel {
    display: flex; flex-direction: column;
    background: #fffdf9;
    border: 1px solid #e8dfd6;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #3d3631;
  }

  .pip-inline-panel .pip-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid #ede6dd;
    flex-shrink: 0;
  }
  .pip-inline-panel .pip-header-left { display: flex; align-items: center; gap: 8px; }
  .pip-inline-panel .pip-icon { width: 16px; height: 16px; color: #9b4e2c; }
  .pip-inline-panel .pip-title {
    font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
    color: #9b4e2c; text-transform: uppercase;
  }
  .pip-inline-panel .pip-header-right { display: flex; align-items: center; gap: 4px; }
  .pip-inline-panel .pip-pin-btn,
  .pip-inline-panel .pip-close-btn {
    width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
    border: none; background: transparent; color: #a09388; cursor: pointer;
    border-radius: 6px; transition: all 0.15s;
  }
  .pip-inline-panel .pip-pin-btn:hover,
  .pip-inline-panel .pip-close-btn:hover { background: #f0e8df; color: #6b5d52; }
  .pip-inline-panel .pip-pin-btn.pinned { color: #9b4e2c; }

  .pip-inline-panel .pip-stream-content {
    flex: 1; display: flex; flex-direction: column;
    padding: 8px 14px; overflow: hidden; gap: 0;
  }

  .pip-inline-panel .pip-empty {
    height: 100%; display: flex; align-items: center; justify-content: center;
    color: #b8ada2; font-size: 13px; font-style: italic;
  }

  .pip-inline-panel .pip-lang-section {
    display: flex; flex-direction: column; min-height: 0;
  }
  .pip-inline-panel .pip-source-section { flex: 2; }
  .pip-inline-panel .pip-target-section { flex: 3; }

  .pip-inline-panel .pip-lang-label {
    font-size: 9px; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; margin-bottom: 4px; flex-shrink: 0;
  }
  .pip-inline-panel .pip-source-label { color: #6b5d52; }
  .pip-inline-panel .pip-target-label { color: #9b4e2c; }

  .pip-inline-panel .pip-lang-text-wrap {
    flex: 1; overflow-y: auto; scroll-behavior: smooth;
    mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 100%);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 100%);
  }
  .pip-inline-panel .pip-lang-text-wrap::-webkit-scrollbar { width: 3px; }
  .pip-inline-panel .pip-lang-text-wrap::-webkit-scrollbar-thumb { background: #d9d0c6; border-radius: 3px; }

  .pip-inline-panel .pip-source-text {
    font-size: 12px; line-height: 1.55; color: #6b5d52;
    margin: 0;
  }

  .pip-inline-panel .pip-target-text {
    font-size: 17px; line-height: 1.5; color: #9b4e2c;
    font-weight: 500; margin: 0;
  }
  .pip-inline-panel .pip-target-text.translating {
    color: #b8ada2; font-style: italic; font-weight: 400;
  }

  .pip-inline-panel .pip-divider {
    height: 1px; background: #ede6dd; flex-shrink: 0;
    margin: 6px 0;
  }

  .pip-inline-panel .pip-footer {
    display: flex; justify-content: flex-end; gap: 6px;
    padding: 8px 14px;
    border-top: 1px solid #ede6dd;
    flex-shrink: 0;
  }
  .pip-inline-panel .pip-footer-btn {
    display: flex; align-items: center; gap: 4px;
    padding: 5px 10px; border-radius: 6px;
    border: none; background: transparent;
    font-size: 10px; font-weight: 600; letter-spacing: 0.06em;
    color: #9b4e2c; cursor: pointer; text-transform: uppercase;
    transition: background 0.15s;
  }
  .pip-inline-panel .pip-footer-btn:hover { background: #f5ede5; }
`;
