'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  Calendar,
  Clock,
  Globe,
  Download,
  FileText,
  Sparkles,
  MessageSquare,
  ClipboardList,
  Info,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Volume1,
  Users,
  Target,
  CheckSquare,
  BookOpen,
  AlertCircle,
  Loader2,
  RefreshCw,
  Layers,
  AudioLines,
} from 'lucide-react';
import { useSwipeGesture } from '@/hooks/useSwipeGesture';
import PlaybackSharePopover from '@/components/session/PlaybackSharePopover';
import ChatTab from '@/components/session/ChatTab';
import { useI18n } from '@/lib/i18n';
import type { TranscriptSegment } from '@/types/transcript';
import type { SummaryBlock } from '@/types/summary';
import type { SessionReportData } from '@/types/report';

type MobilePlaybackTab = 'report' | 'transcript' | 'summary' | 'chat' | 'info';

interface SessionData {
  id: string;
  title: string;
  createdAt: string;
  durationMs: number;
  sourceLang: string;
  targetLang: string;
  status: string;
  courseName?: string;
  audioSource?: string;
  sonioxRegion?: string;
}

interface MobilePlaybackLayoutProps {
  session: SessionData;
  segments: TranscriptSegment[];
  summaries: SummaryBlock[];
  reportData: SessionReportData | null;
  reportLoading: boolean;
  /** 收尾后台仍在生成总摘要报告（父级轮询任务队列得知）→ 空态显示「生成中」而非重新生成入口。 */
  reportPendingBg?: boolean;
  // 音频播放
  isPlaying: boolean;
  currentTimeMs: number;
  effectiveDurationMs: number;
  playbackRate: number;
  volume: number;
  muted: boolean;
  onVolumeChange: (v: number) => void;
  onToggleMuted: () => void;
  hasAudio: boolean;
  onTogglePlayback: () => void;
  onSeekToMs: (ms: number, options?: { resumePlayback?: boolean }) => void;
  onCycleSpeed: () => void;
  onSegmentClick: (startMs: number) => void;
  activeSegmentId?: string;
  // 导出
  onOpenExport: () => void;
  // 标题重新生成
  onRegenerateTitle?: () => void;
  regeneratingTitle?: boolean;
  // 报告重新生成（生成失败/缺失时的入口，分享模式隐藏）
  onRegenerateReport?: () => void;
  regeneratingReport?: boolean;
  /** 分享模式：隐藏 Chat tab 和重新生成标题 */
  isShareMode?: boolean;
  // 完整版补全转录（阶段C）：父级 owns 状态/轮询/收费确认弹窗，这里只渲染入口 + 切换。
  /** 门控：非分享 + 会话已完成/归档 + 有录音 时可生成完整版。 */
  canGenerateFull?: boolean;
  /** 打开收费确认弹窗（父级渲染 ConfirmDialog）。 */
  onGenerateFull?: () => void;
  /** 完整版转录进行中（禁用按钮 + spinner）。 */
  fullInProgress?: boolean;
  /** 触发请求在途（禁用按钮）。 */
  fullTriggering?: boolean;
  /** 生成按钮文案（父级按 status 计算：进行中态文案 / 重新生成 / 生成）。 */
  fullButtonLabel?: string;
  /** 完整版就绪 → 显示「实时/完整版」切换。 */
  hasFullTranscript?: boolean;
  /** 当前展示视图。 */
  transcriptView?: 'live' | 'full';
  /** 切换视图（切到 full 时父级懒加载完整版 bundle）。 */
  onSwitchTranscriptView?: (view: 'live' | 'full') => void;
  /** 切换后要展示的转录（父级 computes：full 视图=完整版 segments，否则=实时 segments）。 */
  displaySegments?: TranscriptSegment[];
  /** 完整版 bundle 是否已加载（区分「加载中」与「就绪但空」的空态文案，对齐 desktop）。 */
  fullLoaded?: boolean;
  // 音频增强：父级 owns 状态/轮询，这里只渲染入口 + 「原声/增强」音源切换（对齐 full* 的分工）。
  /** 门控：非分享 + 会话已完成/归档 + 有录音。 */
  canEnhanceAudio?: boolean;
  /** 当前用户所属组是否开通音频增强（服务端解析，据此显隐触发按钮）。 */
  enhanceAvailable?: boolean;
  /** 增强版音频已就绪 → 显示音源切换。 */
  enhanceReady?: boolean;
  /** 排队/处理中（禁用触发 + spinner + 进度）。 */
  enhanceInProgress?: boolean;
  /** 触发请求在途。 */
  enhanceTriggering?: boolean;
  /** 增强状态（'failed' 时触发按钮显示「重试」文案）。 */
  enhanceStatus?: string | null;
  /** worker 实时进度 0-100（拿不到为 null，只显示"处理中"）。 */
  enhanceProgress?: number | null;
  /** 触发增强（免费路径，无确认弹窗）。 */
  onTriggerEnhance?: () => void;
  /** 当前音源。 */
  audioVariant?: 'original' | 'enhanced' | null;
  /** 切换音源（父级带播放进度重新加载音频）。 */
  onSwitchAudioVariant?: (variant: 'original' | 'enhanced') => void;
}

const TAB_KEYS: MobilePlaybackTab[] = ['report', 'transcript', 'summary', 'chat', 'info'];

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ─── 报告内容渲染 ─── */
function ReportContent({
  reportData,
  reportLoading,
  reportPendingBg,
  isShareMode,
  onRegenerateReport,
  regeneratingReport,
}: {
  reportData: SessionReportData | null;
  reportLoading: boolean;
  reportPendingBg?: boolean;
  isShareMode?: boolean;
  onRegenerateReport?: () => void;
  regeneratingReport?: boolean;
}) {
  const { t } = useI18n();

  // 报告失败/缺失时的重新生成按钮（分享模式隐藏）。两处空态复用。
  const regenButton =
    !isShareMode && onRegenerateReport ? (
      <button
        onClick={onRegenerateReport}
        disabled={regeneratingReport}
        data-testid="report-regen-btn"
        className="mt-4 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg
                   bg-rust-50 text-rust-600 text-xs font-medium
                   active:bg-rust-100 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {regeneratingReport ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <RefreshCw className="w-3.5 h-3.5" />
        )}
        {regeneratingReport
          ? t('playback.reportRegenerating')
          : t('playback.reportRegenerate')}
      </button>
    ) : null;

  if (reportLoading) {
    return (
      <div className="text-center text-charcoal-400 text-sm py-12">
        <ClipboardList className="w-6 h-6 mx-auto mb-2 opacity-30 animate-pulse" />
        <p>{t('playback.loadingReport')}</p>
      </div>
    );
  }

  if (!reportData) {
    if (reportPendingBg) {
      return (
        <div
          className="text-center text-charcoal-400 text-sm py-12"
          data-testid="report-generating-bg"
        >
          <Loader2 className="w-6 h-6 mx-auto mb-2 opacity-40 animate-spin" />
          <p>{t('playback.reportGeneratingBg')}</p>
        </div>
      );
    }
    return (
      <div className="text-center text-charcoal-400 text-sm py-12">
        <ClipboardList className="w-6 h-6 mx-auto mb-2 opacity-30" />
        <p>{t('playback.noReport')}</p>
        {regenButton}
      </div>
    );
  }

  if (!reportData.significance.isWorthSummarizing) {
    return (
      <div className="text-center py-12">
        <AlertCircle className="w-8 h-8 mx-auto mb-3 text-charcoal-300" />
        <p className="text-sm text-charcoal-500 font-medium mb-1">{t('playback.insignificantTitle')}</p>
        <p className="text-xs text-charcoal-400">{reportData.significance.reason}</p>
        <div className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-cream-100 text-xs text-charcoal-500">
          {t('playback.score', {
            score: (reportData.significance.score * 100).toFixed(0),
          })}
        </div>
      </div>
    );
  }

  if (!reportData.report) {
    return (
      <div className="text-center text-charcoal-400 text-sm py-12">
        <AlertCircle className="w-6 h-6 mx-auto mb-2 opacity-30" />
        <p>{t('playback.reportFailed')}</p>
        {regenButton}
      </div>
    );
  }

  const report = reportData.report;

  return (
    <div className="space-y-4">
      {/* 报告标题 */}
      <div className="pb-3 border-b border-cream-200">
        <h3 className="font-serif font-bold text-charcoal-800 text-base leading-tight">
          {report.title}
        </h3>
        <p className="text-xs text-charcoal-500 mt-1">{report.topic}</p>
      </div>

      {/* 元信息 */}
      <div className="flex flex-wrap gap-2 text-[11px] text-charcoal-500">
        <span className="flex items-center gap-1">
          <Calendar className="w-3 h-3" /> {report.date}
        </span>
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" /> {report.duration}
        </span>
        <span className="flex items-center gap-1">
          <Users className="w-3 h-3" /> {report.participants.join(', ')}
        </span>
      </div>

      {/* 概要 */}
      <div className="p-3 rounded-lg bg-rust-50/50 border border-rust-100">
        <p className="text-sm text-charcoal-700 leading-relaxed">{report.overview}</p>
      </div>

      {/* 分节内容 */}
      {report.sections.map((section, i) => (
        <div key={i} className="p-3 rounded-lg bg-cream-50 border border-cream-200">
          <h4 className="text-xs font-semibold text-charcoal-700 mb-2 flex items-center gap-1.5">
            <Target className="w-3 h-3 text-rust-400" />
            {section.title}
          </h4>
          <ul className="space-y-1">
            {section.points.map((point, j) => (
              <li key={j} className="text-xs text-charcoal-600 flex gap-1.5">
                <span className="text-rust-400 flex-shrink-0">•</span>
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {/* 关键结论 */}
      {report.conclusions.length > 0 && (
        <div className="p-3 rounded-lg bg-emerald-50/50 border border-emerald-100">
          <h4 className="text-xs font-semibold text-charcoal-700 mb-2 flex items-center gap-1.5">
            <CheckSquare className="w-3 h-3 text-emerald-500" />
            {t('playback.keyConclusions')}
          </h4>
          <ul className="space-y-1">
            {report.conclusions.map((c, i) => (
              <li key={i} className="text-xs text-charcoal-600 flex gap-1.5">
                <span className="text-emerald-500 flex-shrink-0">✓</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 待办事项 */}
      {report.actionItems.length > 0 && (
        <div className="p-3 rounded-lg bg-amber-50/50 border border-amber-100">
          <h4 className="text-xs font-semibold text-charcoal-700 mb-2 flex items-center gap-1.5">
            <ClipboardList className="w-3 h-3 text-amber-500" />
            {t('playback.actionItems')}
          </h4>
          <ul className="space-y-1">
            {report.actionItems.map((item, i) => (
              <li key={i} className="text-xs text-charcoal-600 flex gap-1.5">
                <span className="text-amber-500 flex-shrink-0">□</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 关键术语 */}
      {Object.keys(report.keyTerms).length > 0 && (
        <div className="p-3 rounded-lg bg-cream-50 border border-cream-200">
          <h4 className="text-xs font-semibold text-charcoal-700 mb-2 flex items-center gap-1.5">
            <BookOpen className="w-3 h-3 text-charcoal-400" />
            {t('playback.keyTerms')}
          </h4>
          <div className="space-y-1.5">
            {Object.entries(report.keyTerms).map(([term, def]) => (
              <div key={term} className="text-xs">
                <span className="font-medium text-charcoal-700">{term}</span>
                <span className="text-charcoal-400"> — </span>
                <span className="text-charcoal-500">{def}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 生成时间 */}
      <div className="text-[10px] text-charcoal-300 text-center pt-2">
        {t('playback.reportGeneratedAt', {
          date: new Date(reportData.generatedAt).toLocaleString(),
        })}
      </div>
    </div>
  );
}

/* ─── 主布局组件 ─── */
export default function MobilePlaybackLayout({
  session,
  segments,
  summaries,
  reportData,
  reportLoading,
  reportPendingBg,
  isPlaying,
  currentTimeMs,
  effectiveDurationMs,
  playbackRate,
  volume,
  muted,
  onVolumeChange,
  onToggleMuted,
  hasAudio,
  onTogglePlayback,
  onSeekToMs,
  onCycleSpeed,
  onSegmentClick,
  activeSegmentId,
  onOpenExport,
  onRegenerateTitle,
  regeneratingTitle,
  onRegenerateReport,
  regeneratingReport,
  isShareMode,
  canGenerateFull,
  onGenerateFull,
  fullInProgress,
  fullTriggering,
  fullButtonLabel,
  hasFullTranscript,
  transcriptView = 'live',
  onSwitchTranscriptView,
  displaySegments,
  fullLoaded,
  canEnhanceAudio,
  enhanceAvailable,
  enhanceReady,
  enhanceInProgress,
  enhanceTriggering,
  enhanceStatus,
  enhanceProgress,
  onTriggerEnhance,
  audioVariant,
  onSwitchAudioVariant,
}: MobilePlaybackLayoutProps) {
  const router = useRouter();
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<MobilePlaybackTab>('report');
  const contentRef = useRef<HTMLDivElement>(null);
  const activeSegmentRef = useRef<HTMLDivElement>(null);
  const tabs: Array<{ key: MobilePlaybackTab; label: string; icon: React.ReactNode }> = [
    { key: 'report', label: t('playback.tabReport'), icon: <ClipboardList className="h-4 w-4" /> },
    { key: 'transcript', label: t('playback.transcript'), icon: <FileText className="h-4 w-4" /> },
    { key: 'summary', label: t('playback.tabSummary'), icon: <Sparkles className="h-4 w-4" /> },
    ...(!isShareMode ? [{ key: 'chat' as const, label: t('playback.tabMobileChat'), icon: <MessageSquare className="h-4 w-4" /> }] : []),
    { key: 'info', label: t('playback.tabInfo'), icon: <Info className="h-4 w-4" /> },
  ];

  const effectiveTabKeys = tabs.map((tab) => tab.key);

  // 「实时/完整版」切换后要展示的转录：父级 computes 传 displaySegments；未接完整版则回退实时。
  const transcriptSegments = displaySegments ?? segments;

  // 滑动切换 Tab
  useSwipeGesture(contentRef, {
    onSwipeLeft: () => {
      const idx = effectiveTabKeys.indexOf(activeTab);
      if (idx < effectiveTabKeys.length - 1) setActiveTab(effectiveTabKeys[idx + 1]);
    },
    onSwipeRight: () => {
      const idx = effectiveTabKeys.indexOf(activeTab);
      if (idx > 0) setActiveTab(effectiveTabKeys[idx - 1]);
    },
    threshold: 60,
  });

  const progressPct =
    effectiveDurationMs > 0
      ? Math.min(100, (currentTimeMs / effectiveDurationMs) * 100)
      : 0;
  const audioSourceValue = session.audioSource?.includes('system')
    ? t('playback.audioSourceSystem')
    : session.audioSource?.includes('microphone') || !session.audioSource
      ? t('playback.audioSourceMicrophone')
      : session.audioSource;

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-cream-50">
      {/* ─── Header ─── */}
      <header className="safe-top flex-shrink-0 border-b border-cream-200 bg-white/95 px-3 pb-2 pt-3 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push('/home')}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-cream-100 text-charcoal-600"
            aria-label={t('nav.backToHome')}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>

          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold text-charcoal-800">
              {session.title}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-charcoal-400">
              <span className="flex items-center gap-0.5">
                <Calendar className="h-3 w-3" />
                {formatDate(session.createdAt)}
              </span>
              <span className="flex items-center gap-0.5">
                <Clock className="h-3 w-3" />
                {formatDuration(effectiveDurationMs)}
              </span>
            </div>
          </div>

          {!isShareMode && (
            <PlaybackSharePopover sessionId={session.id} iconOnly />
          )}
          <button
            onClick={onOpenExport}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-cream-100 text-charcoal-600"
            aria-label={t('playback.export')}
          >
            <Download className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* ─── Tab 导航 ─── */}
      <div className="flex-shrink-0 border-b border-cream-200 bg-white/95 backdrop-blur-md">
        <div className="mobile-scroll flex items-stretch overflow-x-auto px-2">
          {tabs.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex min-w-[64px] flex-1 flex-col items-center justify-center gap-1 border-b-2 px-3 py-2 text-[11px] font-medium transition-colors ${
                  active
                    ? 'border-rust-500 text-rust-600'
                    : 'border-transparent text-charcoal-400'
                }`}
              >
                {tab.icon}
                <span className="whitespace-nowrap">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── 内容区 ─── */}
      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 py-4">
          {/* Report */}
          {activeTab === 'report' && (
            <ReportContent
              reportData={reportData}
              reportLoading={reportLoading}
              reportPendingBg={reportPendingBg}
              isShareMode={isShareMode}
              onRegenerateReport={onRegenerateReport}
              regeneratingReport={regeneratingReport}
            />
          )}

          {/* Transcript */}
          {activeTab === 'transcript' && (
            <div className="space-y-3">
              {/* 音频增强：触发入口 / 处理中态 / 「原声/增强」音源切换（状态由父级 owns） */}
              {canEnhanceAudio &&
                (enhanceReady || enhanceInProgress || enhanceAvailable) && (
                  <div className="space-y-2 pb-1">
                    {enhanceReady ? (
                      <div
                        className="inline-flex w-full items-center rounded-lg bg-cream-100 p-0.5"
                        role="tablist"
                        aria-label={t('playback.audioEnhance.toggleLabel')}
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={audioVariant === 'original'}
                          data-testid="audio-original"
                          onClick={() => onSwitchAudioVariant?.('original')}
                          className={`flex-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                            audioVariant === 'original'
                              ? 'bg-white text-charcoal-700 shadow-sm'
                              : 'text-charcoal-400'
                          }`}
                        >
                          {t('playback.audioEnhance.original')}
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={audioVariant === 'enhanced'}
                          data-testid="audio-enhanced"
                          onClick={() => onSwitchAudioVariant?.('enhanced')}
                          className={`flex-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors flex items-center justify-center gap-1 ${
                            audioVariant === 'enhanced'
                              ? 'bg-white text-rust-600 shadow-sm'
                              : 'text-charcoal-400'
                          }`}
                        >
                          <AudioLines className="w-3 h-3" />
                          {t('playback.audioEnhance.enhanced')}
                        </button>
                      </div>
                    ) : enhanceInProgress ? (
                      <div
                        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg
                                   bg-cream-100 text-charcoal-400 text-xs font-medium"
                        data-testid="enhance-processing"
                      >
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        {t('playback.audioEnhance.processing')}
                        {enhanceProgress != null && enhanceProgress > 0 && (
                          <span className="tabular-nums">
                            {Math.round(enhanceProgress)}%
                          </span>
                        )}
                      </div>
                    ) : (
                      <button
                        onClick={onTriggerEnhance}
                        disabled={enhanceTriggering}
                        data-testid="enhance-audio-btn"
                        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg
                                   bg-rust-50 text-rust-600 text-xs font-medium
                                   active:bg-rust-100 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {enhanceTriggering ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <AudioLines className="w-3.5 h-3.5" />
                        )}
                        {enhanceStatus === 'failed'
                          ? t('playback.audioEnhance.retry')
                          : t('playback.audioEnhance.button')}
                      </button>
                    )}
                  </div>
                )}
              {/* 完整版补全转录：生成入口 + 「实时/完整版」切换（收费确认弹窗由父级渲染） */}
              {(canGenerateFull || hasFullTranscript) && (
                <div className="space-y-2 pb-1">
                  {canGenerateFull && (
                    <button
                      onClick={onGenerateFull}
                      disabled={fullInProgress || fullTriggering}
                      data-testid="full-transcribe-btn"
                      className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg
                                 bg-rust-50 text-rust-600 text-xs font-medium
                                 active:bg-rust-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {fullInProgress ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Layers className="w-3.5 h-3.5" />
                      )}
                      {fullButtonLabel}
                    </button>
                  )}
                  {hasFullTranscript && (
                    <div
                      className="inline-flex w-full items-center rounded-lg bg-cream-100 p-0.5"
                      role="tablist"
                      aria-label={t('playback.transcript')}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={transcriptView === 'live'}
                        data-testid="view-live"
                        onClick={() => onSwitchTranscriptView?.('live')}
                        className={`flex-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                          transcriptView === 'live'
                            ? 'bg-white text-charcoal-700 shadow-sm'
                            : 'text-charcoal-400'
                        }`}
                      >
                        {t('playback.fullTranscribe.viewLive')}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={transcriptView === 'full'}
                        data-testid="view-full"
                        onClick={() => onSwitchTranscriptView?.('full')}
                        className={`flex-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                          transcriptView === 'full'
                            ? 'bg-white text-rust-600 shadow-sm'
                            : 'text-charcoal-400'
                        }`}
                      >
                        {t('playback.fullTranscribe.viewFull')}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {transcriptSegments.length === 0 ? (
                <div className="text-center text-charcoal-400 text-sm py-12">
                  <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p>
                    {transcriptView === 'full'
                      ? fullLoaded
                        ? t('playback.fullTranscribe.empty')
                        : t('playback.fullTranscribe.loading')
                      : t('playback.transcriptEmpty')}
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 pb-2 text-[11px] text-charcoal-400">
                    <Globe className="w-3 h-3" />
                    {session.sourceLang.toUpperCase()} → {session.targetLang.toUpperCase()}
                    <span className="ml-auto">
                      {t('playback.transcriptSegments', { count: transcriptSegments.length })}
                    </span>
                  </div>
                  {transcriptSegments.map((seg) => (
                    <div
                      key={seg.id}
                      ref={activeSegmentId === seg.id ? activeSegmentRef : undefined}
                      onClick={() => onSegmentClick(seg.globalStartMs)}
                      className={`p-3 rounded-lg cursor-pointer transition-colors ${
                        activeSegmentId === seg.id
                          ? 'bg-rust-50 border border-rust-200'
                          : 'bg-white border border-cream-200 active:bg-cream-50'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-mono text-charcoal-400">
                          {formatDuration(seg.globalStartMs)}
                        </span>
                        {seg.language && (
                          <span className="tag-badge text-[10px]">{seg.language.toUpperCase()}</span>
                        )}
                      </div>
                      <p className="text-sm text-charcoal-800 leading-relaxed">{seg.text}</p>
                      {seg.translatedText && (
                        <p className="text-sm text-rust-600/80 leading-relaxed mt-1">
                          {seg.translatedText}
                        </p>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {/* Summary */}
          {activeTab === 'summary' && (
            <div className="space-y-4">
              {summaries.length === 0 ? (
                <div className="text-center text-charcoal-400 text-sm py-12">
                  <Sparkles className="w-6 h-6 mx-auto mb-2 opacity-30" />
                  <p>{t('playback.summaryEmpty')}</p>
                </div>
              ) : (
                summaries.map((block, i) => (
                  <div key={i} className="p-3 rounded-lg bg-cream-50 border border-cream-200">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[10px] font-mono text-charcoal-400">
                        {formatDuration(block.timeRange.startMs)} – {formatDuration(block.timeRange.endMs)}
                      </span>
                    </div>
                    <p className="text-sm text-charcoal-700 mb-2">{block.summary}</p>
                    {block.keyPoints.length > 0 && (
                      <ul className="space-y-1">
                        {block.keyPoints.map((pt, j) => (
                          <li key={j} className="text-xs text-charcoal-600 flex gap-1.5">
                            <span className="text-rust-400">•</span>
                            {pt}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* Chat — 分享模式下隐藏 */}
          {activeTab === 'chat' && !isShareMode && (
            <div className="-mx-4 -my-4 h-[calc(100dvh-theme(spacing.48))]">
              <ChatTab inputSticky />
            </div>
          )}

          {/* Info */}
          {activeTab === 'info' && (
            <div className="space-y-3">
              {onRegenerateTitle && !isShareMode && (
                <button
                  onClick={onRegenerateTitle}
                  disabled={regeneratingTitle}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg
                             bg-rust-50 text-rust-600 text-xs font-medium
                             active:bg-rust-100 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {regeneratingTitle
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <RefreshCw className="w-3.5 h-3.5" />}
                  {t('playback.regenerateTitle')}
                </button>
              )}
              {[
                { label: t('playback.infoSessionId'), value: session.id },
                { label: t('playback.infoStatus'), value: session.status },
                { label: t('playback.infoDuration'), value: formatDuration(effectiveDurationMs) },
                { label: t('playback.infoSourceLanguage'), value: session.sourceLang },
                { label: t('playback.infoTargetLanguage'), value: session.targetLang },
                {
                  label: t('playback.infoAudioSource'),
                  value: audioSourceValue,
                },
                {
                  label: t('playback.infoSonioxRegion'),
                  value: session.sonioxRegion || t('playback.autoRegion'),
                },
                { label: t('playback.infoCourse'), value: session.courseName || '—' },
              ].map(({ label, value }) => (
                <div
                  key={label}
                  className="flex justify-between items-center py-2.5 border-b border-cream-100 last:border-0"
                >
                  <span className="text-xs text-charcoal-400">{label}</span>
                  <span className="text-xs text-charcoal-700 font-medium text-right max-w-[60%] break-all">
                    {value}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ─── 底部音频播放器 ─── */}
      <div className="flex-shrink-0 border-t border-cream-200 bg-white/95 backdrop-blur-md shadow-[0_-4px_20px_rgba(0,0,0,0.05)] safe-bottom">
        {/* 进度条 — 放在顶部，更容易点击 */}
        <div
          className="h-2 bg-cream-200 cursor-pointer active:bg-cream-300"
          onClick={(e) => {
            if (!hasAudio || effectiveDurationMs <= 0) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            const nextTimeMs = Math.max(0, Math.min(effectiveDurationMs, effectiveDurationMs * pct));
            onSeekToMs(nextTimeMs, { resumePlayback: isPlaying });
          }}
        >
          <div
            className="h-full bg-rust-500 transition-all duration-100"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        <div className="px-3 py-2">
          {/* 时间显示 */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-mono text-charcoal-500 tabular-nums">
              {formatDuration(currentTimeMs)}
            </span>
            <span className="text-[11px] font-mono text-charcoal-400 tabular-nums">
              {formatDuration(effectiveDurationMs)}
            </span>
          </div>

          {/* 控制按钮 */}
          <div className="flex items-center justify-between">
            {/* 倍速 */}
            <button
              onClick={onCycleSpeed}
              className="flex h-9 min-w-[44px] items-center justify-center rounded-full border border-cream-300 px-3
                         text-[11px] font-mono font-medium text-charcoal-600 active:bg-cream-100"
            >
              {playbackRate}x
            </button>

            {/* 中间播放控制 */}
            <div className="flex items-center gap-3">
              <button
                onClick={() => onSeekToMs(currentTimeMs - 10000, { resumePlayback: isPlaying })}
                className="flex h-11 w-11 items-center justify-center rounded-full
                           text-charcoal-500 active:bg-cream-100"
                aria-label={t('playback.backTenSeconds')}
              >
                <SkipBack className="h-5 w-5" />
              </button>

              <button
                onClick={onTogglePlayback}
                disabled={!hasAudio}
                className="flex h-12 w-12 items-center justify-center rounded-full
                           bg-rust-500 text-white shadow-sm shadow-rust-500/20
                           active:bg-rust-600 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label={isPlaying ? t('common.pause') : t('common.start')}
              >
                {isPlaying ? (
                  <Pause className="h-5 w-5" />
                ) : (
                  <Play className="h-5 w-5 ml-0.5" />
                )}
              </button>

              <button
                onClick={() => onSeekToMs(currentTimeMs + 10000, { resumePlayback: isPlaying })}
                className="flex h-11 w-11 items-center justify-center rounded-full
                           text-charcoal-500 active:bg-cream-100"
                aria-label={t('playback.forwardTenSeconds')}
              >
                <SkipForward className="h-5 w-5" />
              </button>
            </div>

            {/* 音量控制 */}
            <div className="flex items-center gap-2">
              <button
                onClick={onToggleMuted}
                className="flex h-9 w-9 items-center justify-center rounded-full text-charcoal-500 active:bg-cream-100 transition-colors"
                aria-label={muted ? t('common.unmute') : t('common.mute')}
              >
                {muted || volume === 0 ? (
                  <VolumeX className="h-4 w-4" />
                ) : volume < 0.5 ? (
                  <Volume1 className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const next = parseFloat(e.target.value);
                  onVolumeChange(next);
                  if (next > 0 && muted) onToggleMuted();
                }}
                className="playback-volume-slider w-20"
                style={{
                  background: `linear-gradient(to right, var(--theme-accent) 0%, var(--theme-accent) ${(muted ? 0 : volume) * 100}%, var(--theme-track) ${(muted ? 0 : volume) * 100}%, var(--theme-track) 100%)`,
                }}
                aria-label={t('common.volume')}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
