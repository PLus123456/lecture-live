'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { MessageSquare, ChevronDown } from 'lucide-react';
import { hasPreviewContent } from '@/lib/transcriptPreview';
import { useI18n } from '@/lib/i18n';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useTranslationStore } from '@/stores/translationStore';
import { useViewerSettingsStore } from '@/stores/viewerSettingsStore';
import { FONT_SIZE_MAP, sanitizeDisplayText } from './viewerShared';

function ViewerTypingIndicator({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <div className="flex items-center gap-1 px-1 py-1">
      <div className={`typing-dot w-1.5 h-1.5 rounded-full ${theme === 'dark' ? 'bg-rust-400' : 'bg-rust-400'}`} />
      <div className={`typing-dot w-1.5 h-1.5 rounded-full ${theme === 'dark' ? 'bg-rust-400' : 'bg-rust-400'}`} />
      <div className={`typing-dot w-1.5 h-1.5 rounded-full ${theme === 'dark' ? 'bg-rust-400' : 'bg-rust-400'}`} />
    </div>
  );
}

export function ViewerTranscriptPanel({ isLive }: { isLive: boolean }) {
  const { t } = useI18n();
  const segments = useTranscriptStore((s) => s.segments);
  const currentPreviewText = useTranscriptStore((s) => s.currentPreviewText);
  const currentPreviewTranslationText = useTranscriptStore(
    (s) => s.currentPreviewTranslationText
  );
  const translations = useTranslationStore((s) => s.translations);
  const translationEntries = useTranslationStore((s) => s.translationEntries);
  const fontSize = useViewerSettingsStore((s) => s.fontSize);
  const autoScrollSetting = useViewerSettingsStore((s) => s.autoScroll);
  const compact = useViewerSettingsStore((s) => s.compact);
  const theme = useViewerSettingsStore((s) => s.theme);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const userScrolledRef = useRef(false);
  const isAutoScrollingRef = useRef(false);

  const fs = FONT_SIZE_MAP[fontSize];

  const handleScroll = useCallback(() => {
    if (isAutoScrollingRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceFromBottom < 80;
    if (!isNearBottom && !userScrolledRef.current) {
      userScrolledRef.current = true;
      setAutoScroll(false);
    }
    if (isNearBottom && userScrolledRef.current) {
      userScrolledRef.current = false;
      setAutoScroll(true);
    }
  }, []);

  useEffect(() => {
    if (!autoScroll || !autoScrollSetting) return;
    const el = scrollRef.current;
    if (!el) return;
    isAutoScrollingRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      isAutoScrollingRef.current = false;
    });
  }, [
    segments,
    currentPreviewText,
    currentPreviewTranslationText,
    autoScroll,
    autoScrollSetting,
  ]);

  const scrollToBottom = useCallback(() => {
    setAutoScroll(true);
    userScrolledRef.current = false;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const hasPreview = hasPreviewContent(currentPreviewText);
  const hasPreviewTranslation = hasPreviewContent(currentPreviewTranslationText);
  const showPreviewTranslationWaiting =
    hasPreview &&
    currentPreviewTranslationText.state === 'waiting' &&
    !hasPreviewTranslation;

  return (
    <div className={`flex flex-col h-full relative rounded-xl border overflow-hidden ${
      theme === 'dark'
        ? 'bg-charcoal-800 border-charcoal-600'
        : 'bg-white border-cream-200'
    }`}>
      <div className={`flex items-center justify-between px-5 py-3 border-b flex-shrink-0 ${
        theme === 'dark' ? 'border-charcoal-600' : 'border-cream-200'
      }`}>
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-rust-500" />
          <h2 className={`font-serif font-semibold text-sm ${
            theme === 'dark' ? 'text-cream-100' : 'text-charcoal-800'
          }`}>
            {t('viewer.liveTranscript')}
          </h2>
        </div>
        <span className={`text-xs ${theme === 'dark' ? 'text-cream-500' : 'text-charcoal-400'}`}>
          {t('transcriptPanel.segmentCount', { n: segments.length })}
        </span>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={`flex-1 overflow-y-auto px-5 min-h-0 ${compact ? 'py-2' : 'py-4'}`}
      >
        {segments.length === 0 && !hasPreview && (
          <div className={`flex flex-col items-center justify-center h-full ${
            theme === 'dark' ? 'text-charcoal-500' : 'text-charcoal-300'
          }`}>
            <MessageSquare className="w-10 h-10 mb-3 opacity-50" />
            <p className="text-sm">{t('viewer.waitTranscript')}</p>
          </div>
        )}

        <div className={compact ? 'space-y-2' : 'space-y-4'}>
          {segments.map((seg) => {
            const translation = translationEntries[seg.id]?.text ?? translations[seg.id] ?? '';
            return (
              <div key={seg.id}>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`${fs.timestamp} font-mono ${
                    theme === 'dark' ? 'text-charcoal-500' : 'text-charcoal-300'
                  }`}>
                    {sanitizeDisplayText(seg.timestamp)}
                  </span>
                  {seg.language && (
                    <span className={`${fs.timestamp} px-1.5 py-0.5 rounded ${
                      theme === 'dark'
                        ? 'bg-charcoal-700 text-cream-400'
                        : 'bg-cream-100 text-charcoal-500'
                    }`}>
                      {sanitizeDisplayText(seg.language).toUpperCase()}
                    </span>
                  )}
                </div>
                <p className={`${fs.text} leading-relaxed ${
                  theme === 'dark' ? 'text-cream-200' : 'text-charcoal-600'
                }`}>
                  {sanitizeDisplayText(seg.text)}
                </p>
                {translation && (
                  <p className={`${fs.translation} font-medium leading-relaxed mt-0.5 ${
                    theme === 'dark' ? 'text-rust-400' : 'text-rust-700'
                  }`}>
                    {sanitizeDisplayText(translation)}
                  </p>
                )}
              </div>
            );
          })}

          {/* 实时预览：稳定部分与已落段同色，只有尾巴保持淡色 */}
          {hasPreview && (
            <div>
              <p className={`${fs.text} leading-relaxed`}>
                {currentPreviewText.finalText ? (
                  <span className={theme === 'dark' ? 'text-cream-200' : 'text-charcoal-600'}>
                    {sanitizeDisplayText(currentPreviewText.finalText)}
                  </span>
                ) : null}
                {currentPreviewText.nonFinalText ? (
                  <span className={theme === 'dark' ? 'text-cream-400' : 'text-charcoal-400'}>
                    {sanitizeDisplayText(currentPreviewText.nonFinalText)}
                  </span>
                ) : null}
              </p>
              {hasPreviewTranslation && (
                <p className={`${fs.translation} font-medium leading-relaxed mt-0.5`}>
                  {currentPreviewTranslationText.finalText ? (
                    <span className={theme === 'dark' ? 'text-rust-300' : 'text-rust-700'}>
                      {sanitizeDisplayText(currentPreviewTranslationText.finalText)}
                    </span>
                  ) : null}
                  {currentPreviewTranslationText.nonFinalText ? (
                    <span className={theme === 'dark' ? 'text-rust-400' : 'text-rust-500'}>
                      {sanitizeDisplayText(currentPreviewTranslationText.nonFinalText)}
                    </span>
                  ) : null}
                </p>
              )}

              {showPreviewTranslationWaiting && (
                <p className={`${fs.translation} italic leading-relaxed mt-0.5 ${
                  theme === 'dark' ? 'text-charcoal-500' : 'text-charcoal-300'
                }`}>
                  {t('translationPanel.translating')}
                </p>
              )}
            </div>
          )}

          {isLive && !hasPreview && segments.length > 0 && (
            <ViewerTypingIndicator theme={theme} />
          )}
        </div>

        <div className="h-24 shrink-0" />
      </div>

      {!autoScroll && autoScrollSetting && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2
                     flex items-center gap-1.5 px-3 py-1.5 rounded-full
                     bg-charcoal-800/90 text-white text-xs font-medium
                     shadow-lg hover:bg-charcoal-700 transition-colors z-10"
        >
          <ChevronDown className="w-3.5 h-3.5" />
          {t('viewer.scrollToLatest')}
        </button>
      )}
    </div>
  );
}
