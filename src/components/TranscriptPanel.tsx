'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { hasPreviewContent } from '@/lib/transcriptPreview';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useTranslationStore } from '@/stores/translationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/lib/i18n';
import { MessageSquare, ChevronDown } from 'lucide-react';

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-1 py-1">
      <div className="typing-dot w-1.5 h-1.5 rounded-full bg-rust-400" />
      <div className="typing-dot w-1.5 h-1.5 rounded-full bg-rust-400" />
      <div className="typing-dot w-1.5 h-1.5 rounded-full bg-rust-400" />
    </div>
  );
}

export default function TranscriptPanel({
  className = '',
  contentClassName = '',
  showHeader = true,
  compact = false,
}: {
  className?: string;
  contentClassName?: string;
  showHeader?: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const segments = useTranscriptStore((s) => s.segments);
  const currentPreviewText = useTranscriptStore((s) => s.currentPreviewText);
  const currentPreviewTranslationText = useTranscriptStore(
    (s) => s.currentPreviewTranslationText
  );
  const recordingState = useTranscriptStore((s) => s.recordingState);
  const translations = useTranslationStore((s) => s.translations);
  const translationEntries = useTranslationStore((s) => s.translationEntries);
  const targetLang = useSettingsStore((s) => s.targetLang);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const userScrolledRef = useRef(false);
  const isAutoScrollingRef = useRef(false);

  // 检测用户是否手动滚动离开底部
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

  // 新内容到达时自动滚动到底部
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    isAutoScrollingRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      isAutoScrollingRef.current = false;
    });
  }, [segments, currentPreviewText, currentPreviewTranslationText, autoScroll]);

  const scrollToBottom = useCallback(() => {
    setAutoScroll(true);
    userScrolledRef.current = false;
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  const hasTranslation = !!targetLang;
  const hasPreview = hasPreviewContent(currentPreviewText);
  const hasPreviewTranslation = hasPreviewContent(currentPreviewTranslationText);
  const showPreviewTranslationWaiting =
    hasTranslation &&
    hasPreview &&
    currentPreviewTranslationText.state === 'waiting' &&
    !hasPreviewTranslation;

  return (
    <div className={`panel-card relative flex h-full flex-col ${className}`.trim()}>
      {/* Header */}
      {showHeader ? (
        <div className="flex flex-shrink-0 items-center justify-between border-b border-cream-200 px-5 py-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-rust-500" />
            <h2 className="font-serif font-semibold text-charcoal-800 text-sm">
              {t('transcriptPanel.title')}
            </h2>
          </div>
          <span className="text-xs text-charcoal-400">
            {t('transcriptPanel.segmentCount', { n: segments.length })}
          </span>
        </div>
      ) : null}

      {/* Content */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={`min-h-0 flex-1 overflow-y-auto px-5 py-4 ${contentClassName}`.trim()}
      >
        {segments.length === 0 && recordingState === 'idle' && !hasPreview && (
          <div className="flex flex-col items-center justify-center h-full text-charcoal-300">
            <MessageSquare className="w-10 h-10 mb-3 opacity-50" />
            <p className="text-sm">{t('transcriptPanel.empty')}</p>
          </div>
        )}

        <div className={compact ? 'space-y-2' : 'space-y-4'}>
          {/* 已确认的 segments — 不显示说话人，只有时间戳 + 文本 + 翻译 */}
          {segments.map((seg) => {
            const translationEntry = hasTranslation
              ? translationEntries[seg.id]
              : null;
            const translation = hasTranslation
              ? translationEntry?.text ?? translations[seg.id] ?? ''
              : '';
            return (
              <div key={seg.id} className="segment-enter">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] text-charcoal-300 font-mono">
                    {seg.timestamp}
                  </span>
                  {seg.language && (
                    <span className="tag-badge text-[10px]">{seg.language.toUpperCase()}</span>
                  )}
                </div>

                <p className={`text-charcoal-600 leading-relaxed ${compact ? 'text-[13px]' : 'text-sm'}`}>
                  {seg.text}
                </p>

                {hasTranslation && (
                  <div className="mt-0.5 min-h-[1.5rem]">
                    {translation ? (
                      <p className={`font-medium text-rust-700 leading-relaxed translation-enter ${compact ? 'text-[15px]' : 'text-base'}`}>
                        {translation}
                      </p>
                    ) : (
                      <p className={`text-charcoal-300 italic leading-relaxed ${compact ? 'text-[15px]' : 'text-base'}`}>
                        {t('transcriptPanel.translating')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* 实时 preview */}
          {hasPreview && (
            <div>
              <p className={`leading-relaxed ${compact ? 'text-[13px]' : 'text-sm'}`}>
                {currentPreviewText.finalText ? (
                  <span className="text-charcoal-600">
                    {currentPreviewText.finalText}
                  </span>
                ) : null}
                {currentPreviewText.nonFinalText ? (
                  <span className="text-charcoal-400">
                    {currentPreviewText.nonFinalText}
                  </span>
                ) : null}
              </p>

              {hasTranslation && hasPreviewTranslation && (
                <div className="mt-0.5">
                  <p className={`font-medium leading-relaxed ${compact ? 'text-[15px]' : 'text-base'}`}>
                    {currentPreviewTranslationText.finalText ? (
                      <span className="text-rust-700">
                        {currentPreviewTranslationText.finalText}
                      </span>
                    ) : null}
                    {currentPreviewTranslationText.nonFinalText ? (
                      <span className="text-rust-500">
                        {currentPreviewTranslationText.nonFinalText}
                      </span>
                    ) : null}
                  </p>
                </div>
              )}

              {showPreviewTranslationWaiting && (
                <div className="mt-0.5">
                  <p className={`text-charcoal-300 italic leading-relaxed ${compact ? 'text-[15px]' : 'text-base'}`}>
                    {t('transcriptPanel.translating')}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* 打字指示器 */}
          {recordingState === 'recording' && !hasPreview && segments.length > 0 && (
            <TypingIndicator />
          )}
        </div>

        <div ref={bottomRef} className="h-24 shrink-0" />
      </div>

      {!autoScroll && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2
                     flex items-center gap-1.5 px-3 py-1.5 rounded-full
                     bg-charcoal-800/90 text-white text-xs font-medium
                     shadow-lg hover:bg-charcoal-700 transition-colors z-10"
        >
          <ChevronDown className="w-3.5 h-3.5" />
          {t('transcriptPanel.scrollToLatest')}
        </button>
      )}
    </div>
  );
}
