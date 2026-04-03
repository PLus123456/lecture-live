'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import BottomSheet from '@/components/mobile/BottomSheet';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  X,
  FileText,
  Download,
  Loader2,
  FileType,
  Clock,
  BookOpen,
  Mic,
  Package,
  FilePlus,
  Check,
  AlertCircle,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';
import type { ExportTranscriptSegment } from '@/lib/export/types';
import type { SummarizeResponse } from '@/types/summary';
import type { SessionReportData } from '@/types/report';
import {
  buildExportPlan,
  executeExport,
  isFormatAvailable,
  normalizeContentsForFormat,
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
  /** 外部提供的录音获取回调（优先于内部 fetch，避免重复下载） */
  fetchRecording?: () => Promise<Blob | null>;
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

interface SessionExportDataResponse {
  title?: string;
  sourceLang?: string;
  targetLang?: string;
  segments?: ExportTranscriptSegment[];
  translations?: Record<string, string>;
  summaries?: SummarizeResponse[];
  report?: SessionReportData | null;
  hasRecording?: boolean;
}

function getAvailableContents(options: {
  hasTranscript: boolean;
  hasSummary: boolean;
  hasTimedSummary: boolean;
  hasRecording: boolean;
}): ContentType[] {
  const contents: ContentType[] = [];

  if (options.hasTranscript) contents.push('transcript');
  if (options.hasSummary) contents.push('summary');
  if (options.hasTimedSummary) contents.push('timedSummary');
  if (options.hasRecording) contents.push('recording');

  return contents;
}

function getDefaultSelectedContents(availableContents: ContentType[]): ContentType[] {
  const defaults = ['transcript', 'summary'].filter((content) =>
    availableContents.includes(content as ContentType)
  ) as ContentType[];

  if (defaults.length > 0) {
    return defaults;
  }

  if (availableContents.includes('timedSummary')) {
    return ['timedSummary'];
  }

  if (availableContents.includes('recording')) {
    return ['recording'];
  }

  return [];
}

function hasItems<T>(value?: T[]): value is T[] {
  return Array.isArray(value) && value.length > 0;
}

function hasEntries(value?: Record<string, string>): value is Record<string, string> {
  return Boolean(value && Object.keys(value).length > 0);
}

function resolveArrayOverride<T>(override: T[] | undefined, fallback: T[] | undefined): T[] {
  if (hasItems(override)) {
    return override;
  }

  if (Array.isArray(fallback)) {
    return fallback;
  }

  return override ?? [];
}

function resolveRecordOverride(
  override: Record<string, string> | undefined,
  fallback: Record<string, string> | undefined,
): Record<string, string> {
  if (hasEntries(override)) {
    return override;
  }

  if (fallback) {
    return fallback;
  }

  return override ?? {};
}

function resolveHasRecording(
  override: boolean | undefined,
  fallback: boolean | undefined,
): boolean {
  if (override === true) {
    return true;
  }

  return Boolean(fallback);
}

function isSameContents(left: ContentType[], right: ContentType[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((content, index) => content === right[index]);
}

export default function ExportModal({
  isOpen,
  onClose,
  sessionTitle,
  sessionId,
  sourceLang,
  targetLang,
  segments: segmentsOverride,
  translations: translationsOverride,
  summaries: summariesOverride,
  report,
  hasRecording,
  fetchRecording: fetchRecordingProp,
}: ExportModalProps) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);

  const [sessionData, setSessionData] = useState<SessionExportDataResponse | null>(null);
  const [isLoadingSessionData, setIsLoadingSessionData] = useState(false);

  const hasProvidedContentData =
    hasItems(segmentsOverride) ||
    hasEntries(translationsOverride) ||
    hasItems(summariesOverride) ||
    report != null;

  const fetchSessionData = useCallback(async (): Promise<SessionExportDataResponse | null> => {
    if (!sessionId || !token) return null;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/export-data`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      return await res.json() as SessionExportDataResponse;
    } catch {
      return null;
    }
  }, [sessionId, token]);

  useEffect(() => {
    if (!isOpen) {
      setError(null);
      setSessionData(null);
      return;
    }

    setSessionData(null);

    if (!sessionId || !token) {
      return;
    }

    let cancelled = false;
    setIsLoadingSessionData(true);

    void fetchSessionData()
      .then((data) => {
        if (!cancelled && data) {
          setSessionData(data);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingSessionData(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, sessionId, token, fetchSessionData]);

  const exportSegments = resolveArrayOverride(segmentsOverride, sessionData?.segments);
  const exportTranslations = resolveRecordOverride(translationsOverride, sessionData?.translations);
  const exportSummaries = resolveArrayOverride(summariesOverride, sessionData?.summaries);
  const exportReport = report ?? sessionData?.report ?? null;
  const exportHasRecording = Boolean(resolveHasRecording(hasRecording, sessionData?.hasRecording) && sessionId);
  const displayTitle =
    (typeof sessionTitle === 'string' && sessionTitle.trim()) ||
    sessionData?.title ||
    t('session.defaultTitle');

  // 可用性判断
  const hasTranscript = exportSegments.length > 0;
  const hasSummary =
    exportSummaries.some((s) => !s.timeRange) ||
    Boolean(exportReport?.significance?.isWorthSummarizing && exportReport.report);
  const hasTimedSummary = exportSummaries.some((s) => s.timeRange);

  // 状态
  const [selectedContents, setSelectedContents] = useState<ContentType[]>([]);
  const [selectedFormat, setSelectedFormat] = useState<ExportFileFormat>('docx');
  const [documentMode, setDocumentMode] = useState<DocumentMode>('single');
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableContents = useMemo(
    () =>
      getAvailableContents({
        hasTranscript,
        hasSummary,
        hasTimedSummary,
        hasRecording: exportHasRecording,
      }),
    [hasTranscript, hasSummary, hasTimedSummary, exportHasRecording],
  );

  useEffect(() => {
    if (!isOpen) return;

    setSelectedContents((prev) => {
      const filtered = prev.filter((content) => availableContents.includes(content));
      const normalized = normalizeContentsForFormat(filtered, selectedFormat);
      if (filtered.length > 0) {
        return normalized;
      }
      return normalizeContentsForFormat(getDefaultSelectedContents(availableContents), selectedFormat);
    });
  }, [isOpen, availableContents, selectedFormat]);

  // 当前选择的文本内容数量
  const showSessionDataLoadingState =
    isLoadingSessionData && !hasProvidedContentData && !sessionData;
  const onlyRecordingSelected =
    selectedContents.length === 1 && selectedContents[0] === 'recording';

  // 内容复选框切换（节流防止移动端快速连点导致崩溃）
  const lastToggleRef = useRef(0);
  const toggleContent = useCallback((id: ContentType) => {
    const now = Date.now();
    if (now - lastToggleRef.current < 120) return;
    lastToggleRef.current = now;

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
    if (onlyRecordingSelected) return true;
    return !isFormatAvailable(format, selectedContents);
  }, [selectedContents, onlyRecordingSelected]);

  // 确保选中的格式仍然可用
  const effectiveFormat = useMemo(() => {
    if (onlyRecordingSelected) return selectedFormat;
    if (isFormatDisabled(selectedFormat)) {
      const available = FORMAT_OPTIONS.find((f) => !isFormatDisabled(f.id));
      return available?.id ?? 'md';
    }
    return selectedFormat;
  }, [selectedFormat, isFormatDisabled, onlyRecordingSelected]);

  useEffect(() => {
    if (!isOpen || effectiveFormat !== 'srt') return;

    setSelectedContents((prev) => {
      const normalized = normalizeContentsForFormat(prev, 'srt');
      return isSameContents(prev, normalized) ? prev : normalized;
    });
  }, [isOpen, effectiveFormat]);

  const effectiveSelectedContents = useMemo(
    () => normalizeContentsForFormat(selectedContents, effectiveFormat),
    [selectedContents, effectiveFormat],
  );
  const currentTextCount = textContentCount(effectiveSelectedContents);
  const hasAnyTextContent = hasTextContent(effectiveSelectedContents);
  const onlyRecording =
    effectiveSelectedContents.length === 1 && effectiveSelectedContents[0] === 'recording';
  const showDocumentMode = currentTextCount >= 2;
  const exportPlan = useMemo(
    () => buildExportPlan(effectiveSelectedContents, effectiveFormat, documentMode),
    [effectiveSelectedContents, effectiveFormat, documentMode],
  );

  // 是否可导出
  const canExport =
    !showSessionDataLoadingState &&
    effectiveSelectedContents.length > 0 &&
    (onlyRecording || hasAnyTextContent);

  // 下载录音的回调：优先使用外部传入的（复用已加载 blob），否则自行 fetch
  const internalFetchRecording = useCallback(async (): Promise<Blob | null> => {
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

  const fetchRecording = fetchRecordingProp ?? internalFetchRecording;

  // 执行导出
  const handleExport = async () => {
    if (!canExport) return;
    setIsExporting(true);
    setError(null);

    try {
      let latestSessionData = sessionData;
      if (sessionId && !latestSessionData) {
        latestSessionData = await fetchSessionData();
        if (latestSessionData) {
          setSessionData(latestSessionData);
        }
      }

      const segments = resolveArrayOverride(segmentsOverride, latestSessionData?.segments);
      const translations = resolveRecordOverride(translationsOverride, latestSessionData?.translations);
      const summaries = resolveArrayOverride(summariesOverride, latestSessionData?.summaries);
      const sessionReport = report ?? latestSessionData?.report ?? null;
      const sessionSourceLang = sourceLang ?? latestSessionData?.sourceLang ?? 'en';
      const sessionTargetLang = targetLang ?? latestSessionData?.targetLang ?? 'zh';
      const resolvedTitle =
        (typeof sessionTitle === 'string' && sessionTitle.trim()) ||
        latestSessionData?.title ||
        t('session.defaultTitle');

      if (sessionId && !hasProvidedContentData && !latestSessionData) {
        throw new Error('Failed to load session export data');
      }

      await executeExport({
        contents: effectiveSelectedContents,
        format: effectiveFormat,
        documentMode,
        payload: {
          title: resolvedTitle,
          date: new Date().toISOString(),
          sourceLang: sessionSourceLang,
          targetLang: sessionTargetLang,
          segments,
          translations,
          summaries,
          report: sessionReport,
        },
        fetchRecording: effectiveSelectedContents.includes('recording') ? fetchRecording : undefined,
      });

      onClose();
    } catch (err) {
      console.error('Export error:', err);
      if (err instanceof Error) {
        if (
          err.message === 'Recording download failed' ||
          err.message === 'Missing recording fetcher'
        ) {
          setError(t('exportModal.recordingDownloadError'));
        } else {
          setError(t('exportModal.exportError'));
        }
      } else {
        setError(t('exportModal.exportError'));
      }
    } finally {
      setIsExporting(false);
    }
  };

  if (!isOpen) return null;

  const content = (
    <div className="flex flex-col max-h-[70vh] md:max-h-none">
      {showSessionDataLoadingState && (
        <div className="px-5 pt-4 animate-fade-slide-in">
          <div className="flex items-center gap-2 rounded-xl border border-cream-200 bg-cream-50 px-3 py-2 text-xs text-charcoal-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t('exportModal.loadingData')}
          </div>
        </div>
      )}

      {/* 步骤1：选择导出内容 */}
      <div className="px-5 pt-4 pb-3">
        <div className="flex items-center gap-2 mb-3">
          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-rust-500 text-white text-xs font-bold">1</span>
          <span className="text-sm font-semibold text-charcoal-700">{t('exportModal.stepContent')}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {CONTENT_OPTIONS.map((opt) => {
            const disabled =
              showSessionDataLoadingState ||
              (opt.id === 'transcript' && !hasTranscript) ||
              (opt.id === 'summary' && !hasSummary) ||
              (opt.id === 'timedSummary' && !hasTimedSummary) ||
              (opt.id === 'recording' && !exportHasRecording) ||
              (effectiveFormat === 'srt' && (opt.id === 'summary' || opt.id === 'timedSummary'));
            const selected = effectiveSelectedContents.includes(opt.id);
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
        <div className="px-5 pt-2 pb-3 border-t border-cream-100 animate-fade-slide-in">
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

          {effectiveFormat === 'srt' && (
            <p className="mt-2 text-[10px] text-charcoal-400 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {t('exportModal.srtHint')}
            </p>
          )}
        </div>
      )}

      {/* 步骤3：合并/分开选择 */}
      {showDocumentMode && !onlyRecording && (
        <div className="px-5 pt-2 pb-3 border-t border-cream-100 animate-fade-slide-in">
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
        <div className="mx-5 mb-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600 flex items-center gap-2 animate-fade-slide-in">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* 底栏 */}
      <div className="px-5 py-4 border-t border-cream-200 bg-cream-50/50 safe-bottom">
        {/* 文件数量提示 */}
        <div className="text-[10px] text-charcoal-400 text-center mb-3">
          {exportPlan.willZip ? (
            <span className="inline-flex items-center gap-1">
              <Package className="w-3 h-3" />
              {t('exportModal.willZip', { count: String(exportPlan.downloadFileCount) })}
            </span>
          ) : exportPlan.downloadFileCount === 1 ? (
            <span className="inline-flex items-center gap-1">
              <FileType className="w-3 h-3" />
              {t('exportModal.singleFile')}
            </span>
          ) : null}
        </div>

        <div className="flex items-center justify-center gap-3">
          <button onClick={onClose} className="btn-secondary text-xs px-4 py-1.5">
            {t('common.cancel')}
          </button>
          <button
            onClick={handleExport}
            disabled={isExporting || !canExport}
            className="btn-primary text-xs px-5 py-1.5 flex items-center gap-1.5"
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
                <p className="text-[10px] text-charcoal-400">{displayTitle}</p>
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
