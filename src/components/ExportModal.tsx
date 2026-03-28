'use client';

import { useState } from 'react';
import BottomSheet from '@/components/mobile/BottomSheet';
import { useIsMobile } from '@/hooks/useIsMobile';
import { X, FileText, Download, Loader2 } from 'lucide-react';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useTranslationStore } from '@/stores/translationStore';
import { useAuthStore } from '@/stores/authStore';
import { useSummaryStore } from '@/stores/summaryStore';
import { summaryBlocksToResponses } from '@/lib/summary';
import { useI18n } from '@/lib/i18n';
import type { ExportTranscriptSegment } from '@/lib/export/types';
import type { SummarizeResponse } from '@/types/summary';

export default function ExportModal({
  isOpen,
  onClose,
  sessionTitle,
  sessionId,
  sourceLang = 'en',
  targetLang = 'zh',
  segments: segmentsOverride,
  translations: translationsOverride,
  summaries: summariesOverride,
}: {
  isOpen: boolean;
  onClose: () => void;
  sessionTitle: string;
  sessionId?: string;
  sourceLang?: string;
  targetLang?: string;
  segments?: ExportTranscriptSegment[];
  translations?: Record<string, string>;
  summaries?: SummarizeResponse[];
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [selectedFormat, setSelectedFormat] = useState<string>('markdown');
  const [isExporting, setIsExporting] = useState(false);
  const token = useAuthStore((s) => s.token);
  const segments = useTranscriptStore((s) => s.segments);
  const translations = useTranslationStore((s) => s.translations);
  const summaryBlocks = useSummaryStore((s) => s.blocks);
  const exportSegments = segmentsOverride ?? segments;
  const exportTranslations = translationsOverride ?? translations;
  const exportSummaries = summariesOverride ?? summaryBlocksToResponses(summaryBlocks);
  const canExport = Boolean(sessionId) || exportSegments.length > 0;
  const formats = [
    { id: 'markdown', label: t('exportModal.markdown'), desc: t('exportModal.markdownDesc') },
    { id: 'srt', label: t('exportModal.srt'), desc: t('exportModal.srtDesc') },
    { id: 'json', label: t('exportModal.json'), desc: t('exportModal.jsonDesc') },
    { id: 'txt', label: t('exportModal.txt'), desc: t('exportModal.txtDesc') },
  ] as const;

  if (!isOpen) return null;

  const handleExport = async () => {
    if (!token) {
      console.error('Export requires authentication');
      return;
    }

    setIsExporting(true);
    try {
      const endpoint = sessionId ? `/api/sessions/${sessionId}/export` : '/api/export';
      const payload = sessionId
        ? { format: selectedFormat }
        : {
            format: selectedFormat,
            title: sessionTitle || t('session.defaultTitle'),
            date: new Date().toISOString(),
            sourceLang,
            targetLang,
            segments: exportSegments,
            translations: exportTranslations,
            summaries: exportSummaries,
          };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error('Export failed');

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ext = selectedFormat === 'markdown' ? 'md' : selectedFormat;
      a.href = url;
      a.download = `${sessionTitle || 'lecture'}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      onClose();
    } catch (error) {
      console.error('Export error:', error);
    } finally {
      setIsExporting(false);
    }
  };

  const content = (
    <>
      <div className="px-6 py-5 space-y-2">
        {formats.map((fmt) => (
          <button
            key={fmt.id}
            onClick={() => setSelectedFormat(fmt.id)}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left
                       border transition-colors ${
                         selectedFormat === fmt.id
                           ? 'border-rust-400 bg-rust-50'
                           : 'border-cream-200 hover:border-cream-400'
                       }`}
          >
            <div
              className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                selectedFormat === fmt.id
                  ? 'border-rust-500'
                  : 'border-charcoal-300'
              }`}
            >
              {selectedFormat === fmt.id && (
                <div className="w-2 h-2 rounded-full bg-rust-500" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-charcoal-700">{fmt.label}</p>
              <p className="text-xs text-charcoal-400">{fmt.desc}</p>
            </div>
          </button>
        ))}
      </div>

      <div className="px-6 py-4 border-t border-cream-200 flex justify-end gap-3 bg-white safe-bottom">
        <button onClick={onClose} className="btn-secondary text-sm">
          {t('common.cancel')}
        </button>
        <button
          onClick={handleExport}
          disabled={isExporting || !canExport}
          className="btn-primary text-sm flex items-center gap-2"
        >
          {isExporting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          {t('common.download')}
        </button>
      </div>
    </>
  );

  if (isMobile) {
    return (
      <BottomSheet open={isOpen} onClose={onClose} title={t('exportModal.title')}>
        {content}
      </BottomSheet>
    );
  }

  return (
    <>
      <div className="fixed inset-0 bg-charcoal-900/30 backdrop-blur-sm z-50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-[420px] max-w-full">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-cream-200">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-rust-500" />
              <h2 className="font-serif font-bold text-charcoal-800">{t('exportModal.title')}</h2>
            </div>
            <button onClick={onClose} className="btn-ghost p-1.5">
              <X className="w-4 h-4" />
            </button>
          </div>

          {content}
        </div>
      </div>
    </>
  );
}
