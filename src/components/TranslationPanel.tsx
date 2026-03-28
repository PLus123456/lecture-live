'use client';

import { useEffect, useRef } from 'react';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useTranslationStore } from '@/stores/translationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/lib/i18n';
import { Languages, Cloud, Cpu, Loader2 } from 'lucide-react';

const LANG_NAMES: Record<string, string> = {
  zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean',
  fr: 'French', de: 'German', es: 'Spanish',
};

export default function TranslationPanel({
  className = '',
  contentClassName = '',
  showHeader = true,
}: {
  className?: string;
  contentClassName?: string;
  showHeader?: boolean;
}) {
  const { t } = useI18n();
  const segments = useTranscriptStore((s) => s.segments);
  const translations = useTranslationStore((s) => s.translations);
  const mode = useTranslationStore((s) => s.mode);
  const setMode = useTranslationStore((s) => s.setMode);
  const localModelLoaded = useTranslationStore((s) => s.localModelLoaded);
  const localModelProgress = useTranslationStore((s) => s.localModelProgress);
  const localModelStatus = useTranslationStore((s) => s.localModelStatus);
  const targetLang = useSettingsStore((s) => s.targetLang);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [translations, segments]);

  const targetLanguageLabel = targetLang
    ? (() => {
        const translated = t(`languages.${targetLang}`);
        return translated === `languages.${targetLang}` ? targetLang : translated;
      })()
    : '';

  return (
    <div className={`panel-card flex h-full flex-col ${className}`.trim()}>
      {/* Header */}
      {showHeader ? (
        <div className="flex items-center justify-between px-5 py-3 border-b border-cream-200">
          <div className="flex items-center gap-2">
            <Languages className="w-4 h-4 text-rust-500" />
            <h2 className="font-serif font-semibold text-charcoal-800 text-sm">
              {t('translationPanel.title')}
            </h2>
            <span className="text-xs text-charcoal-400">
              → {targetLanguageLabel || LANG_NAMES[targetLang] || targetLang}
            </span>
          </div>

          {/* Mode toggle */}
          <div className="flex items-center bg-cream-100 rounded-lg p-0.5 border border-cream-200">
            <button
              onClick={() => setMode('soniox')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                mode === 'soniox'
                  ? 'bg-white text-rust-600 shadow-sm'
                  : 'text-charcoal-400 hover:text-charcoal-600'
              }`}
            >
              <Cloud className="w-3 h-3" />
              {t('translationPanel.cloud')}
            </button>
            <button
              onClick={() => setMode('local')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                mode === 'local'
                  ? 'bg-white text-rust-600 shadow-sm'
                  : 'text-charcoal-400 hover:text-charcoal-600'
              }`}
            >
              <Cpu className="w-3 h-3" />
              {t('translationPanel.local')}
            </button>
          </div>
        </div>
      ) : null}

      {/* Model loading progress */}
      {mode === 'local' && !localModelLoaded && (
        <div className="px-5 py-3 bg-cream-50 border-b border-cream-200">
          <div className="flex items-center gap-2 mb-1.5">
            <Loader2 className="w-3.5 h-3.5 text-rust-500 animate-spin" />
            <span className="text-xs text-charcoal-500">
              {localModelStatus || t('translationPanel.preparingLocalModel')}
            </span>
          </div>
          <div className="w-full h-1.5 bg-cream-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-rust-400 rounded-full transition-all duration-300"
              style={{ width: `${localModelProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Translated segments */}
      <div ref={scrollRef} className={`flex-1 overflow-y-auto px-5 py-4 space-y-3 ${contentClassName}`.trim()}>
        {segments.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-charcoal-300">
            <Languages className="w-10 h-10 mb-3 opacity-50" />
            <p className="text-sm">{t('translationPanel.empty')}</p>
          </div>
        )}

        {segments.map((seg) => {
          const translation = translations[seg.id];
          return (
            <div
              key={seg.id}
              className="py-2 border-b border-cream-100 last:border-0"
            >
              <span className="text-[11px] text-charcoal-300 font-mono">
                {seg.timestamp}
              </span>
              {translation ? (
                <p className="text-sm text-charcoal-700 leading-relaxed mt-0.5">
                  {translation}
                </p>
              ) : (
                <p className="text-sm text-charcoal-300 italic mt-0.5">
                  {t('translationPanel.translating')}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
