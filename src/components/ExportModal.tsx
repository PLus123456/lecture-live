'use client';

import { useState, useCallback, useMemo } from 'react';
import BottomSheet from '@/components/mobile/BottomSheet';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  X,
  FileText,
  Download,
  Loader2,
  FileType,
  FileAudio,
  Clock,
  BookOpen,
  Mic,
  Package,
  FilePlus,
  Check,
  AlertCircle,
} from 'lucide-react';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useTranslationStore } from '@/stores/translationStore';
import { useAuthStore } from '@/stores/authStore';
import { useSummaryStore } from '@/stores/summaryStore';
import { summaryBlocksToResponses } from '@/lib/summary';
import { useI18n } from '@/lib/i18n';
import type { ExportTranscriptSegment } from '@/lib/export/types';
import type { SummarizeResponse } from '@/types/summary';
import type { SessionReportData } from '@/types/report';
import {
  executeExport,
  isFormatAvailable,
  textContentCount,
  hasTextContent,
  type ContentType,
  type ExportFileFormat,
  type DocumentMode,
} from '@/lib/export/clientExport';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionTitle: string;
  sessionId?: string;
  sourceLang?: string;
  targetLang?: string;
  segments?: ExportTranscriptSegment[];
  translations?: Record<string, string>;
  summaries?: SummarizeResponse[];
  report?: SessionReportData | null;
  /** 是否有可用录音 */
  hasRecording?: boolean;
}

// ─── 内容选项定义 ───

interface ContentOption {
  id: ContentType;
  icon: typeof FileText;
  labelKey: string;
  descKey: string;
}

const CONTENT_OPTIONS: ContentOption[] = [
  { id: 'transcript', icon: FileText, labelKey: 'exportModal.contentTranscript', descKey: 'exportModal.contentTranscriptDesc' },
  { id: 'summary', icon: BookOpen, labelKey: 'exportModal.contentSummary', descKey: 'exportModal.contentSummaryDesc' },
  { id: 'timedSummary', icon: Clock, labelKey: 'exportModal.contentTimedSummary', descKey: 'exportModal.contentTimedSummaryDesc' },
  { id: 'recording', icon: Mic, labelKey: 'exportModal.contentRecording', descKey: 'exportModal.contentRecordingDesc' },
];

// ─── 格式选项定义 ───

interface FormatOption {
  id: ExportFileFormat;
  label: string;
  desc: string;
  ext: string;
  color: string;
}

const FORMAT_OPTIONS: FormatOption[] = [
  { id: 'docx', label: 'Word', desc: '.docx', ext: 'docx', color: 'bg-blue-500' },
  { id: 'pdf', label: 'PDF', desc: '.pdf', ext: 'pdf', color: 'bg-red-500' },
  { id: 'md', label: 'Markdown', desc: '.md', ext: 'md', color: 'bg-gray-600' },
  { id: 'txt', label: '纯文本', desc: '.txt', ext: 'txt', color: 'bg-charcoal-400' },
  { id: 'srt', label: 'SRT 字幕', desc: '.srt', ext: 'srt', color: 'bg-green-600' },
  { id: 'json', label: 'JSON', desc: '.json', ext: 'json', color: 'bg-amber-600' },
];

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
  report,
  hasRecording = false,
}: ExportModalProps) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);

  // Store 数据
  const storeSegments = useTranscriptStore((s) => s.segments);
  const storeTranslations = useTranslationStore((s) => s.translations);
  const summaryBlocks = useSummaryStore((s) => s.blocks);
  const exportSegments = segmentsOverride ?? storeSegments;
  const exportTranslations = translationsOverride ?? storeTranslations;
  const exportSummaries = summariesOverride ?? summaryBlocksToResponses(summaryBlocks);

  // 可用性判断
  const hasTranscript = exportSegments.length > 0;
  const hasSummary = exportSummaries.some((s) => !s.timeRange) || Boolean(report?.significance?.isWorthSummarizing);
  const hasTimedSummary = exportSummaries.some((s) => s.timeRange);

  // 状态
  const [selectedContents, setSelectedContents] = useState<ContentType[]>(
    ['transcript', 'summary'].filter((c) => {
      if (c === 'transcript') return hasTranscript;
      if (c === 'summary') return hasSummary;
      return false;
    }) as ContentType[],
  );
  const [selectedFormat, setSelectedFormat] = useState<ExportFileFormat>('docx');
  const [documentMode, setDocumentMode] = useState<DocumentMode>('single');
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 当前选择的文本内容数量
  const currentTextCount = textContentCount(selectedContents);
  const hasAnyTextContent = hasTextContent(selectedContents);
  const showDocumentMode = currentTextCount >= 2;
  const onlyRecording = selectedContents.length === 1 && selectedContents[0] === 'recording';

  // 将产生多少个文件
  const estimatedFileCount = useMemo(() => {
    let count = 0;
    if (hasAnyTextContent) {
      count += documentMode === 'separate' ? currentTextCount : 1;
    }
    if (selectedContents.includes('recording')) count += 1;
    return count;
  }, [selectedContents, documentMode, hasAnyTextContent, currentTextCount]);

  const willZip = estimatedFileCount >= 2;

  // 内容复选框切换
  const toggleContent = useCallback((id: ContentType) => {
    setSelectedContents((prev) => {
      const next = prev.includes(id)
        ? prev.filter((c) => c !== id)
        : [...prev, id];
      return next;
    });
    setError(null);
  }, []);

  // 格式是否可选
  const isFormatDisabled = useCallback((format: ExportFileFormat) => {
    if (onlyRecording) return true;
    return !isFormatAvailable(format, selectedContents);
  }, [selectedContents, onlyRecording]);

  // 确保选中的格式仍然可用
  const effectiveFormat = useMemo(() => {
    if (onlyRecording) return selectedFormat;
    if (isFormatDisabled(selectedFormat)) {
      const available = FORMAT_OPTIONS.find((f) => !isFormatDisabled(f.id));
      return available?.id ?? 'md';
    }
    return selectedFormat;
  }, [selectedFormat, isFormatDisabled, onlyRecording]);

  // 是否可导出
  const canExport = selectedContents.length > 0 && (onlyRecording || hasAnyTextContent);

  // 下载录音的回调
  const fetchRecording = useCallback(async (): Promise<Blob | null> => {
    if (!sessionId || !token) return null;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/audio`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      return await res.blob();
    } catch {
      return null;
    }
  }, [sessionId, token]);

  // 从服务端获取完整会话数据
  const fetchSessionData = useCallback(async () => {
    if (!sessionId || !token) return null;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/export-data`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }, [sessionId, token]);

  // 执行导出
  const handleExport = async () => {
    if (!canExport) return;
    setIsExporting(true);
    setError(null);

    try {
      // 尝试从服务端获取完整数据（如果有 sessionId 且本地数据为空）
      let segments = exportSegments;
      let translations = exportTranslations;
      let summaries = exportSummaries;
      let sessionReport = report ?? null;

      if (sessionId && segments.length === 0) {
        const data = await fetchSessionData();
        if (data) {
          segments = data.segments ?? [];
          translations = data.translations ?? {};
          summaries = data.summaries ?? [];
          sessionReport = data.report ?? null;
        }
      }

      await executeExport({
        contents: selectedContents,
        format: onlyRecording ? 'md' : effectiveFormat,
        documentMode,
        payload: {
          title: sessionTitle || t('session.defaultTitle'),
          date: new Date().toISOString(),
          sourceLang,
          targetLang,
          segments,
          translations,
          summaries,
          report: sessionReport,
        },
        fetchRecording: selectedContents.includes('recording') ? fetchRecording : undefined,
      });

      onClose();
    } catch (err) {
      console.error('Export error:', err);
      setError(t('exportModal.exportError'));
    } finally {
      setIsExporting(false);
    }
  };

  if (!isOpen) return null;

  const content = (
    <div className="flex flex-col max-h-[70vh] md:max-h-none">
      {/* 步骤1：选择导出内容 */}
      <div className="px-5 pt-4 pb-3">
        <div className="flex items-center gap-2 mb-3">
          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-rust-500 text-white text-xs font-bold">1</span>
          <span className="text-sm font-semibold text-charcoal-700">{t('exportModal.stepContent')}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {CONTENT_OPTIONS.map((opt) => {
            const disabled =
              (opt.id === 'transcript' && !hasTranscript) ||
              (opt.id === 'summary' && !hasSummary) ||
              (opt.id === 'timedSummary' && !hasTimedSummary) ||
              (opt.id === 'recording' && !hasRecording);
            const selected = selectedContents.includes(opt.id);
            const Icon = opt.icon;

            return (
              <button
                key={opt.id}
                onClick={() => !disabled && toggleContent(opt.id)}
                disabled={disabled}
                className={`
                  relative flex flex-col items-start gap-1 p-3 rounded-xl border-2 text-left
                  transition-all duration-150
                  ${disabled
                    ? 'border-cream-200 bg-cream-50 opacity-40 cursor-not-allowed'
                    : selected
                      ? 'border-rust-400 bg-rust-50 shadow-sm'
                      : 'border-cream-200 bg-white hover:border-cream-400 hover:shadow-sm'
                  }
                `}
              >
                {/* 选中标记 */}
                {selected && (
                  <div className="absolute top-2 right-2 w-4 h-4 rounded-full bg-rust-500 flex items-center justify-center">
                    <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />
                  </div>
                )}
                <Icon className={`w-4 h-4 ${selected ? 'text-rust-500' : 'text-charcoal-400'}`} />
                <div>
                  <p className={`text-xs font-medium ${selected ? 'text-rust-700' : 'text-charcoal-600'}`}>
                    {t(opt.labelKey)}
                  </p>
                  <p className="text-[10px] text-charcoal-400 leading-tight mt-0.5">
                    {t(opt.descKey)}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 步骤2：选择格式 */}
      {!onlyRecording && (
        <div className="px-5 pt-2 pb-3 border-t border-cream-100">
          <div className="flex items-center gap-2 mb-3">
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-rust-500 text-white text-xs font-bold">2</span>
            <span className="text-sm font-semibold text-charcoal-700">{t('exportModal.stepFormat')}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {FORMAT_OPTIONS.map((fmt) => {
              const disabled = isFormatDisabled(fmt.id);
              const selected = effectiveFormat === fmt.id;

              return (
                <button
                  key={fmt.id}
                  onClick={() => !disabled && setSelectedFormat(fmt.id)}
                  disabled={disabled}
                  className={`
                    flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium
                    transition-all duration-150
                    ${disabled
                      ? 'border-cream-200 text-charcoal-300 cursor-not-allowed'
                      : selected
                        ? 'border-rust-400 bg-rust-500 text-white shadow-sm'
                        : 'border-cream-200 text-charcoal-600 hover:border-cream-400 hover:bg-cream-50'
                    }
                  `}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${disabled ? 'bg-cream-300' : selected ? 'bg-white' : fmt.color}`} />
                  {fmt.label}
                  <span className={`text-[10px] ${selected ? 'text-rust-100' : 'text-charcoal-300'}`}>
                    {fmt.desc}
                  </span>
                </button>
              );
            })}
          </div>

          {effectiveFormat === 'pdf' && (
            <p className="mt-2 text-[10px] text-charcoal-400 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {t('exportModal.pdfHint')}
            </p>
          )}
        </div>
      )}

      {/* 步骤3：合并/分开选择 */}
      {showDocumentMode && !onlyRecording && (
        <div className="px-5 pt-2 pb-3 border-t border-cream-100">
          <div className="flex items-center gap-2 mb-3">
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-rust-500 text-white text-xs font-bold">3</span>
            <span className="text-sm font-semibold text-charcoal-700">{t('exportModal.stepMode')}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setDocumentMode('single')}
              className={`
                flex items-center gap-2 p-3 rounded-xl border-2 transition-all duration-150
                ${documentMode === 'single'
                  ? 'border-rust-400 bg-rust-50'
                  : 'border-cream-200 hover:border-cream-400'
                }
              `}
            >
              <Package className={`w-4 h-4 ${documentMode === 'single' ? 'text-rust-500' : 'text-charcoal-400'}`} />
              <div className="text-left">
                <p className={`text-xs font-medium ${documentMode === 'single' ? 'text-rust-700' : 'text-charcoal-600'}`}>
                  {t('exportModal.modeSingle')}
                </p>
                <p className="text-[10px] text-charcoal-400">{t('exportModal.modeSingleDesc')}</p>
              </div>
            </button>
            <button
              onClick={() => setDocumentMode('separate')}
              className={`
                flex items-center gap-2 p-3 rounded-xl border-2 transition-all duration-150
                ${documentMode === 'separate'
                  ? 'border-rust-400 bg-rust-50'
                  : 'border-cream-200 hover:border-cream-400'
                }
              `}
            >
              <FilePlus className={`w-4 h-4 ${documentMode === 'separate' ? 'text-rust-500' : 'text-charcoal-400'}`} />
              <div className="text-left">
                <p className={`text-xs font-medium ${documentMode === 'separate' ? 'text-rust-700' : 'text-charcoal-600'}`}>
                  {t('exportModal.modeSeparate')}
                </p>
                <p className="text-[10px] text-charcoal-400">{t('exportModal.modeSeparateDesc')}</p>
              </div>
            </button>
          </div>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="mx-5 mb-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* 底栏 */}
      <div className="px-5 py-4 border-t border-cream-200 flex items-center justify-between bg-cream-50/50 safe-bottom">
        {/* 文件数量提示 */}
        <div className="text-[10px] text-charcoal-400">
          {willZip ? (
            <span className="flex items-center gap-1">
              <Package className="w-3 h-3" />
              {t('exportModal.willZip', { count: String(estimatedFileCount) })}
            </span>
          ) : selectedContents.length > 0 ? (
            <span className="flex items-center gap-1">
              <FileType className="w-3 h-3" />
              {t('exportModal.singleFile')}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <button onClick={onClose} className="btn-secondary text-xs px-3 py-1.5">
            {t('common.cancel')}
          </button>
          <button
            onClick={handleExport}
            disabled={isExporting || !canExport}
            className="btn-primary text-xs px-4 py-1.5 flex items-center gap-1.5"
          >
            {isExporting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            {isExporting ? t('exportModal.exporting') : t('common.download')}
          </button>
        </div>
      </div>
    </div>
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
      <div className="fixed inset-0 bg-charcoal-900/30 backdrop-blur-sm z-50 animate-backdrop-enter" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-[480px] max-w-full animate-modal-enter overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-cream-200 bg-gradient-to-r from-rust-50 to-cream-50">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-rust-500 flex items-center justify-center">
                <Download className="w-3.5 h-3.5 text-white" />
              </div>
              <div>
                <h2 className="font-serif font-bold text-charcoal-800 text-sm">{t('exportModal.title')}</h2>
                <p className="text-[10px] text-charcoal-400">{sessionTitle}</p>
              </div>
            </div>
            <button onClick={onClose} className="btn-ghost p-1.5 rounded-lg hover:bg-cream-100">
              <X className="w-4 h-4" />
            </button>
          </div>

          {content}
        </div>
      </div>
    </>
  );
}
