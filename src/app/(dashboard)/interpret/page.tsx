'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, MicOff, ArrowUpDown, Circle } from 'lucide-react';
import { useInterpret, type InterpretLine } from '@/hooks/useInterpret';
import { useI18n } from '@/lib/i18n';
import { useAuthStore } from '@/stores/authStore';

/** 支持的语言对列表 */
const LANG_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'ru', label: 'Русский' },
  { value: 'pt', label: 'Português' },
  { value: 'ar', label: 'العربية' },
];

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function getLangLabel(code: string): string {
  return LANG_OPTIONS.find((o) => o.value === code)?.label ?? code;
}

/** 单侧面板：显示原文和翻译的内容流 */
function LangPanel({
  langCode,
  lines,
  previewText,
  previewTranslation,
  isPreviewSide,
  label,
  direction,
}: {
  langCode: string;
  lines: InterpretLine[];
  previewText: string;
  previewTranslation: string;
  isPreviewSide: boolean;
  label: string;
  direction: 'top' | 'bottom';
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, previewText]);

  const borderClass =
    direction === 'top' ? 'border-b border-cream-200' : '';

  return (
    <div className={`flex flex-1 flex-col min-h-0 ${borderClass}`}>
      {/* 语言标签 */}
      <div className="flex items-center gap-2 px-4 py-2 bg-cream-50 border-b border-cream-100 flex-shrink-0">
        <span className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
          {label}
        </span>
        <span className="text-xs text-charcoal-400">
          {getLangLabel(langCode)}
        </span>
      </div>

      {/* 内容区域 */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-2"
      >
        {lines.length === 0 && !isPreviewSide && (
          <p className="text-sm text-charcoal-300 italic text-center mt-8">
            {/* 等待内容 */}
          </p>
        )}
        {lines.map((line) => (
          <div key={line.id} className="text-sm leading-relaxed">
            {line.language ? (
              // 原文行
              <p className="text-charcoal-800">{line.text}</p>
            ) : (
              // 翻译行（language 为空表示这是翻译内容）
              <p className="text-rust-500 text-[13px]">{line.text}</p>
            )}
          </div>
        ))}

        {/* 实时预览 */}
        {isPreviewSide && previewText && (
          <div className="text-sm leading-relaxed">
            <p className="text-charcoal-500 italic">{previewText}</p>
          </div>
        )}
        {!isPreviewSide && previewTranslation && (
          <div className="text-sm leading-relaxed">
            <p className="text-rust-400 italic text-[13px]">{previewTranslation}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function InterpretPage() {
  const { t } = useI18n();
  const quotas = useAuthStore((s) => s.quotas);
  const {
    isRunning,
    connectionState,
    linesA,
    linesB,
    previewText,
    previewTranslation,
    previewLang,
    elapsedMs,
    start,
    stop,
  } = useInterpret();

  const [langA, setLangA] = useState('en');
  const [langB, setLangB] = useState('zh');

  const canStart =
    !isRunning &&
    langA !== langB &&
    quotas &&
    quotas.transcriptionMinutesUsed < quotas.transcriptionMinutesLimit;

  const handleSwap = useCallback(() => {
    if (isRunning) return;
    setLangA(langB);
    setLangB(langA);
  }, [isRunning, langA, langB]);

  const handleStart = useCallback(async () => {
    if (!canStart) return;
    await start(langA, langB);
  }, [canStart, langA, langB, start]);

  const handleStop = useCallback(async () => {
    await stop();
  }, [stop]);

  // 判断当前预览内容属于哪个面板
  const previewIsA = previewLang === langA;

  return (
    <div className="flex flex-col h-screen">
      {/* 顶部控制栏 */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-white border-b border-cream-200 flex-shrink-0">
        <div className="flex items-center gap-3 mr-auto">
          <h1 className="text-lg font-serif font-bold text-charcoal-800 whitespace-nowrap">
            {t('interpret.title')}
          </h1>
          {isRunning && (
            <div className="flex items-center gap-1.5">
              <Circle className="w-2 h-2 fill-red-500 text-red-500 animate-pulse" />
              <span className="text-xs text-charcoal-500 font-mono">
                {formatElapsed(elapsedMs)}
              </span>
            </div>
          )}
        </div>

        {/* 语言选择 + 交换 */}
        <div className="flex items-center gap-2">
          <select
            value={langA}
            onChange={(e) => setLangA(e.target.value)}
            disabled={isRunning}
            className="text-sm border border-cream-200 rounded-lg px-2.5 py-1.5 bg-white
                       text-charcoal-700 disabled:opacity-50 disabled:cursor-not-allowed
                       focus:outline-none focus:ring-2 focus:ring-rust-300"
          >
            {LANG_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <button
            onClick={handleSwap}
            disabled={isRunning}
            className="p-1.5 rounded-lg text-charcoal-400 hover:bg-cream-100
                       hover:text-charcoal-600 disabled:opacity-30 disabled:cursor-not-allowed
                       transition-colors"
            title={t('interpret.swap')}
          >
            <ArrowUpDown className="w-4 h-4" />
          </button>

          <select
            value={langB}
            onChange={(e) => setLangB(e.target.value)}
            disabled={isRunning}
            className="text-sm border border-cream-200 rounded-lg px-2.5 py-1.5 bg-white
                       text-charcoal-700 disabled:opacity-50 disabled:cursor-not-allowed
                       focus:outline-none focus:ring-2 focus:ring-rust-300"
          >
            {LANG_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* 开始/停止按钮 */}
        <div className="flex items-center gap-2">
          {connectionState === 'connecting' && (
            <span className="text-xs text-charcoal-400 animate-pulse">
              {t('common.loading')}
            </span>
          )}

          {!isRunning ? (
            <button
              onClick={() => void handleStart()}
              disabled={!canStart}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                         bg-rust-500 text-white hover:bg-rust-600
                         disabled:opacity-50 disabled:cursor-not-allowed
                         transition-colors shadow-sm"
            >
              <Mic className="w-4 h-4" />
              {t('interpret.start')}
            </button>
          ) : (
            <button
              onClick={() => void handleStop()}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                         bg-red-500 text-white hover:bg-red-600
                         transition-colors shadow-sm"
            >
              <MicOff className="w-4 h-4" />
              {t('interpret.stop')}
            </button>
          )}
        </div>
      </div>

      {/* 配额不足警告 */}
      {quotas &&
        quotas.transcriptionMinutesUsed >= quotas.transcriptionMinutesLimit && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-700 text-sm">
            {t('interpret.quotaWarning')}
          </div>
        )}

      {/* 双面板区域 */}
      <div className="flex-1 flex flex-col min-h-0 bg-white">
        {!isRunning && linesA.length === 0 && linesB.length === 0 ? (
          /* 空状态 */
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-charcoal-400">
            <div className="w-20 h-20 rounded-full bg-cream-100 flex items-center justify-center">
              <Mic className="w-8 h-8 text-charcoal-300" />
            </div>
            <p className="text-sm">{t('interpret.idle')}</p>
          </div>
        ) : (
          <>
            {/* 上半屏 — 语言 A */}
            <LangPanel
              langCode={langA}
              lines={linesA}
              previewText={previewIsA ? previewText : ''}
              previewTranslation={!previewIsA ? previewTranslation : ''}
              isPreviewSide={previewIsA}
              label={t('interpret.langA')}
              direction="top"
            />
            {/* 下半屏 — 语言 B */}
            <LangPanel
              langCode={langB}
              lines={linesB}
              previewText={!previewIsA ? previewText : ''}
              previewTranslation={previewIsA ? previewTranslation : ''}
              isPreviewSide={!previewIsA}
              label={t('interpret.langB')}
              direction="bottom"
            />
          </>
        )}
      </div>
    </div>
  );
}
