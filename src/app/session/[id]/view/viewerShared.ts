// 公开分享页的共享展示工具，避免页面与可测试组件各自维护一份。

export function sanitizeDisplayText(text: unknown): string {
  if (typeof text !== 'string') return '';
  // 移除零宽字符和控制字符（保留常规空格和换行）
  return text.replace(/[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

export const FONT_SIZE_MAP = {
  small: {
    text: 'text-xs',
    translation: 'text-sm',
    timestamp: 'text-[10px]',
    summary: 'text-xs',
    keypoint: 'text-[11px]',
  },
  medium: {
    text: 'text-sm',
    translation: 'text-base',
    timestamp: 'text-[11px]',
    summary: 'text-sm',
    keypoint: 'text-xs',
  },
  large: {
    text: 'text-base',
    translation: 'text-lg',
    timestamp: 'text-xs',
    summary: 'text-base',
    keypoint: 'text-sm',
  },
} as const;
