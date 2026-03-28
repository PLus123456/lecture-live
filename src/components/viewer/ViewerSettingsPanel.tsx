'use client';

// 观看者设置面板 — 仅用于公开分享页面
// 安全注意：此组件不访问任何认证状态，不发起任何 API 请求

import { useEffect, useRef } from 'react';
import {
  Settings,
  X,
  Type,
  Moon,
  Sun,
  ArrowDownToLine,
  Minimize2,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  useViewerSettingsStore,
  type ViewerFontSize,
} from '@/stores/viewerSettingsStore';


function SettingsToggle() {
  const { t } = useI18n();
  const settingsOpen = useViewerSettingsStore((s) => s.settingsOpen);
  const setSettingsOpen = useViewerSettingsStore((s) => s.setSettingsOpen);

  return (
    <button
      onClick={() => setSettingsOpen(!settingsOpen)}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg
                 border border-cream-200 bg-white text-charcoal-500
                 hover:bg-cream-50 hover:text-charcoal-700 transition-colors
                 dark:border-charcoal-600 dark:bg-charcoal-700 dark:text-cream-300
                 dark:hover:bg-charcoal-600"
      aria-label={t('viewerSettings.openSettings')}
    >
      <Settings className="w-4 h-4" />
      <span className="text-xs font-medium hidden sm:inline">{t('viewerSettings.settings')}</span>
    </button>
  );
}

function SettingsDrawer() {
  const { t } = useI18n();
  const drawerRef = useRef<HTMLDivElement>(null);
  const settingsOpen = useViewerSettingsStore((s) => s.settingsOpen);
  const setSettingsOpen = useViewerSettingsStore((s) => s.setSettingsOpen);
  const fontSize = useViewerSettingsStore((s) => s.fontSize);
  const setFontSize = useViewerSettingsStore((s) => s.setFontSize);
  const theme = useViewerSettingsStore((s) => s.theme);
  const setTheme = useViewerSettingsStore((s) => s.setTheme);
  const autoScroll = useViewerSettingsStore((s) => s.autoScroll);
  const setAutoScroll = useViewerSettingsStore((s) => s.setAutoScroll);
  const compact = useViewerSettingsStore((s) => s.compact);
  const setCompact = useViewerSettingsStore((s) => s.setCompact);
  const fontSizes: { value: ViewerFontSize; label: string }[] = [
    { value: 'small', label: t('viewerSettings.sizeSmall') },
    { value: 'medium', label: t('viewerSettings.sizeMedium') },
    { value: 'large', label: t('viewerSettings.sizeLarge') },
  ];

  // 点击外部关闭
  useEffect(() => {
    if (!settingsOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setSettingsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [settingsOpen, setSettingsOpen]);

  if (!settingsOpen) return null;

  return (
    <>
      {/* 半透明遮罩 */}
      <div className="fixed inset-0 bg-black/20 z-40" aria-hidden="true" />

      {/* 设置面板 */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-label={t('viewerSettings.viewingSettings')}
        className="fixed right-0 top-0 h-full w-80 max-w-[90vw] bg-white
                   border-l border-cream-200 shadow-xl z-50 overflow-y-auto
                   dark:bg-charcoal-800 dark:border-charcoal-600
                   animate-in slide-in-from-right duration-200"
      >
        {/* 面板头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-cream-200 dark:border-charcoal-600">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-rust-500" />
            <h2 className="text-sm font-semibold text-charcoal-800 dark:text-cream-100">
              {t('viewerSettings.viewingSettings')}
            </h2>
          </div>
          <button
            onClick={() => setSettingsOpen(false)}
            className="p-1 rounded-md text-charcoal-400 hover:text-charcoal-600
                       hover:bg-cream-100 transition-colors
                       dark:text-cream-400 dark:hover:text-cream-200 dark:hover:bg-charcoal-700"
            aria-label={t('viewerSettings.closeSettings')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-6">
          {/* 主题切换 */}
          <section>
            <h3 className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider mb-3 dark:text-cream-400">
              {t('viewerSettings.theme')}
            </h3>
            <div className="flex items-center bg-cream-100 rounded-lg p-0.5 border border-cream-200 dark:bg-charcoal-700 dark:border-charcoal-600">
              <button
                onClick={() => setTheme('light')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-colors ${
                  theme === 'light'
                    ? 'bg-white text-charcoal-700 shadow-sm dark:bg-charcoal-600 dark:text-cream-100'
                    : 'text-charcoal-400 hover:text-charcoal-600 dark:text-cream-500 dark:hover:text-cream-300'
                }`}
              >
                <Sun className="w-3.5 h-3.5" />
                {t('viewerSettings.light')}
              </button>
              <button
                onClick={() => setTheme('dark')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-colors ${
                  theme === 'dark'
                    ? 'bg-white text-charcoal-700 shadow-sm dark:bg-charcoal-600 dark:text-cream-100'
                    : 'text-charcoal-400 hover:text-charcoal-600 dark:text-cream-500 dark:hover:text-cream-300'
                }`}
              >
                <Moon className="w-3.5 h-3.5" />
                {t('viewerSettings.dark')}
              </button>
            </div>
          </section>

          {/* 字体大小 */}
          <section>
            <h3 className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider mb-3 dark:text-cream-400">
              <Type className="w-3.5 h-3.5 inline mr-1.5" />
              {t('viewerSettings.fontSize')}
            </h3>
            <div className="flex items-center bg-cream-100 rounded-lg p-0.5 border border-cream-200 dark:bg-charcoal-700 dark:border-charcoal-600">
              {fontSizes.map((fs) => (
                <button
                  key={fs.value}
                  onClick={() => setFontSize(fs.value)}
                  className={`flex-1 px-3 py-2 rounded-md text-xs font-medium transition-colors ${
                    fontSize === fs.value
                      ? 'bg-white text-charcoal-700 shadow-sm dark:bg-charcoal-600 dark:text-cream-100'
                      : 'text-charcoal-400 hover:text-charcoal-600 dark:text-cream-500 dark:hover:text-cream-300'
                  }`}
                >
                  {fs.label}
                </button>
              ))}
            </div>
          </section>

          {/* 行为设置 */}
          <section>
            <h3 className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider mb-3 dark:text-cream-400">
              {t('viewerSettings.behavior')}
            </h3>
            <div className="space-y-2">
              <button
                onClick={() => setAutoScroll(!autoScroll)}
                className="flex items-center justify-between w-full px-3 py-2.5 rounded-lg
                           border border-cream-200 bg-cream-50/50 hover:bg-cream-100
                           transition-colors text-left
                           dark:border-charcoal-600 dark:bg-charcoal-700/50 dark:hover:bg-charcoal-700"
              >
                <div className="flex items-center gap-2">
                  <ArrowDownToLine className="w-3.5 h-3.5 text-charcoal-400 dark:text-cream-500" />
                  <span className="text-xs font-medium text-charcoal-600 dark:text-cream-300">
                    {t('viewerSettings.autoScroll')}
                  </span>
                </div>
                <div
                  className={`w-8 h-[18px] rounded-full transition-colors relative ${
                    autoScroll ? 'bg-rust-500' : 'bg-charcoal-200 dark:bg-charcoal-600'
                  }`}
                >
                  <div
                    className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform ${
                      autoScroll ? 'translate-x-[16px]' : 'translate-x-[2px]'
                    }`}
                  />
                </div>
              </button>

              <button
                onClick={() => setCompact(!compact)}
                className="flex items-center justify-between w-full px-3 py-2.5 rounded-lg
                           border border-cream-200 bg-cream-50/50 hover:bg-cream-100
                           transition-colors text-left
                           dark:border-charcoal-600 dark:bg-charcoal-700/50 dark:hover:bg-charcoal-700"
              >
                <div className="flex items-center gap-2">
                  <Minimize2 className="w-3.5 h-3.5 text-charcoal-400 dark:text-cream-500" />
                  <span className="text-xs font-medium text-charcoal-600 dark:text-cream-300">
                    {t('viewerSettings.compactMode')}
                  </span>
                </div>
                <div
                  className={`w-8 h-[18px] rounded-full transition-colors relative ${
                    compact ? 'bg-rust-500' : 'bg-charcoal-200 dark:bg-charcoal-600'
                  }`}
                >
                  <div
                    className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform ${
                      compact ? 'translate-x-[16px]' : 'translate-x-[2px]'
                    }`}
                  />
                </div>
              </button>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

export { SettingsToggle, SettingsDrawer };
