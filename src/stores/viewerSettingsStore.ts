'use client';

// 观看者独立设置存储（与主应用 settingsStore 完全隔离）
// 此 store 仅用于公开分享页面，不包含任何认证信息

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ViewerFontSize = 'small' | 'medium' | 'large';
export type ViewerLayout = '3-col' | '2-col' | '1-col';
export type ViewerTheme = 'light' | 'dark';

interface ViewerPanel {
  transcript: boolean;
  translation: boolean;
  summary: boolean;
}

interface ViewerSettingsStore {
  // 字体大小
  fontSize: ViewerFontSize;
  // 布局模式
  layout: ViewerLayout;
  // 主题
  theme: ViewerTheme;
  // 面板可见性
  panels: ViewerPanel;
  // 自动滚动
  autoScroll: boolean;
  // 紧凑模式（减少间距）
  compact: boolean;
  // 设置面板是否打开
  settingsOpen: boolean;

  // Actions
  setFontSize: (size: ViewerFontSize) => void;
  setLayout: (layout: ViewerLayout) => void;
  setTheme: (theme: ViewerTheme) => void;
  togglePanel: (panel: keyof ViewerPanel) => void;
  setAutoScroll: (enabled: boolean) => void;
  setCompact: (compact: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
}

// 安全的默认值：所有面板可见、中等字体、亮色主题
const DEFAULT_PANELS: ViewerPanel = {
  transcript: true,
  translation: true,
  summary: true,
};

export const useViewerSettingsStore = create<ViewerSettingsStore>()(
  persist(
    (set) => ({
      fontSize: 'medium',
      layout: '3-col',
      theme: 'light',
      panels: { ...DEFAULT_PANELS },
      autoScroll: true,
      compact: false,
      settingsOpen: false,

      setFontSize: (fontSize) => set({ fontSize }),
      setLayout: (layout) => set({ layout }),
      setTheme: (theme) => set({ theme }),
      togglePanel: (panel) =>
        set((state) => {
          const next = { ...state.panels, [panel]: !state.panels[panel] };
          // 至少保留一个面板可见
          const visibleCount = Object.values(next).filter(Boolean).length;
          if (visibleCount === 0) return state;
          return { panels: next };
        }),
      setAutoScroll: (autoScroll) => set({ autoScroll }),
      setCompact: (compact) => set({ compact }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    }),
    {
      name: 'lecture-live-viewer-settings',
      // 不持久化 settingsOpen 状态
      partialize: (state) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { settingsOpen, ...rest } = state;
        return rest;
      },
    }
  )
);
