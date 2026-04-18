'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import UserSettingsModal from '@/components/UserSettingsModal';
import TranscriptPanel from '@/components/TranscriptPanel';
import AiPanel from '@/components/session/AiPanel';
import SettingsDrawer from '@/components/SettingsDrawer';
import ExportModal from '@/components/ExportModal';
import MobileSessionLayout from '@/components/mobile/MobileSessionLayout';
import LiveShareBadge from '@/components/session/LiveShareBadge';
import { useI18n } from '@/lib/i18n';
import { mergeSessionTerms } from '@/lib/keywords/sessionTerms';
import { summaryBlocksToResponses } from '@/lib/summary';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAuthStore } from '@/stores/authStore';
import { useAuth } from '@/hooks/useAuth';
import {
  useTranscriptStore,
  waitForTranscriptHydration,
  type BackupMeta,
} from '@/stores/transcriptStore';
import { useTranslationStore } from '@/stores/translationStore';
import { useSummaryStore } from '@/stores/summaryStore';
import { useSoniox } from '@/hooks/useSoniox';
import { useLiveShare } from '@/hooks/useLiveShare';
import { useLocalTranslation } from '@/hooks/useTranslation';
import { useSummary } from '@/hooks/useSummary';
import { SessionFinalizingOverlay, type FinalizingStep } from '@/components/session/SessionFinalizingOverlay';
import { usePipReferenceTool, PipPortal, InlinePipPanel, VideoPipBridge } from '@/components/session/PipReferenceTool';
import FlagImg from '@/components/FlagImg';
import type { SessionStatus } from '@/types/transcript';
import type { UserQuotas } from '@/types/user';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  QUOTA_WARNING_LEAD_MS,
  getMaxSessionDurationMs,
} from '@/lib/billing';
import {
  Settings,
  Circle,
  Square,
  Download,
  Pencil,
  Check,
  Radio,
  Link2,
  Copy,
  CheckCheck,
  X,
  Pause,
  Play,
  Loader2,
  RefreshCw,
  PictureInPicture2,
} from 'lucide-react';

/* ─── Ping / Latency helpers ─── */
import {
  pingAllRegions,
  setCachedPingResults,
  type ClientPingResult,
} from '@/lib/soniox/clientPing';

function latencyBg(ms: number | null): string {
  if (ms == null) return 'bg-charcoal-200';
  if (ms < 100) return 'bg-emerald-500';
  if (ms < 200) return 'bg-yellow-500';
  return 'bg-red-500';
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function getRegionLabel(
  region: string,
  t: (key: string, params?: Record<string, string | number>) => string
) {
  switch (region) {
    case 'us':
      return t('session.latency.regionUs');
    case 'eu':
      return t('session.latency.regionEu');
    case 'jp':
      return t('session.latency.regionJp');
    default:
      return region.toUpperCase();
  }
}

/* ─── Share Popover ─── */
function SharePopover({
  sessionId,
  isActive,
}: {
  sessionId: string;
  isActive: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { isSharing, shareToken, startSharing, stopSharing } = useLiveShare();

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const handleStartShare = async () => {
    setLoading(true);
    try {
      const data = await startSharing(sessionId);
      if (data) {
        const url = `${window.location.origin}/session/${sessionId}/view?token=${data.token}`;
        setShareUrl(url);
      }
    } catch {
      // silent
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!isSharing || !shareToken) {
      return;
    }
    setShareUrl(`${window.location.origin}/session/${sessionId}/view?token=${shareToken}`);
  }, [isSharing, sessionId, shareToken]);

  const handleStopShare = async () => {
    await stopSharing(sessionId);
    setShareUrl(null);
  };

  const handleCopy = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={!isActive}
        title={isSharing ? t('session.share.liveSharing') : t('session.share.shareSession')}
        className={`expand-btn flex items-center h-9 rounded-lg transition-all duration-200 overflow-hidden
                   disabled:opacity-30 disabled:cursor-not-allowed
                   ${isSharing
                     ? 'bg-red-50 text-red-600 border border-red-200 hover:bg-red-100'
                     : 'border border-cream-300 text-charcoal-600 hover:bg-cream-50'
                   }`}
      >
        <span className="flex-shrink-0 w-9 h-9 flex items-center justify-center">
          <Radio className={`w-3.5 h-3.5 ${isSharing ? 'animate-pulse' : ''}`} />
        </span>
        <span className="expand-label text-xs font-medium">
          {isSharing ? t('session.share.live') : t('session.share.share')}
        </span>
      </button>

      {open && (
        <div className="absolute top-full mt-1.5 right-0 w-72 bg-white border border-cream-300
                        rounded-xl shadow-xl z-50 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-charcoal-800">{t('session.share.title')}</h3>
            <button onClick={() => setOpen(false)} className="text-charcoal-400 hover:text-charcoal-600">
              <X className="w-4 h-4" />
            </button>
          </div>

          {!isSharing ? (
            <div>
              <p className="text-xs text-charcoal-500 mb-3">
                {t('session.share.description')}
              </p>
              <button
                onClick={handleStartShare}
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg
                           bg-rust-500 text-white text-xs font-medium
                           hover:bg-rust-600 transition-colors disabled:opacity-60"
              >
                {loading ? (
                  <span className="animate-spin w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full" />
                ) : (
                  <Link2 className="w-3.5 h-3.5" />
                )}
                {t('session.share.start')}
              </button>
            </div>
          ) : (
            <div>
              {/* Share URL */}
              {shareUrl && (
                <div className="flex items-center gap-2 mb-3 p-2 bg-cream-50 rounded-lg border border-cream-200">
                  <input
                    readOnly
                    value={shareUrl}
                    className="flex-1 text-[11px] bg-transparent text-charcoal-600 outline-none truncate"
                  />
                  <button
                    onClick={handleCopy}
                    className="flex-shrink-0 p-1.5 rounded-md bg-white border border-cream-300
                               hover:bg-cream-100 transition-colors"
                    title={t('session.share.copyLink')}
                  >
                    {copied ? (
                      <CheckCheck className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5 text-charcoal-500" />
                    )}
                  </button>
                </div>
              )}

              <LiveShareBadge />

              <button
                onClick={handleStopShare}
                className="w-full mt-3 flex items-center justify-center gap-2 px-4 py-2 rounded-lg
                           border border-red-200 text-red-600 text-xs font-medium
                           hover:bg-red-50 transition-colors"
              >
                <Square className="w-3 h-3 fill-current" />
                {t('session.share.stop')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Utility functions ─── */
function latencyColor(ms: number | null): string {
  if (ms == null) return 'text-charcoal-400';
  if (ms < 100) return 'text-emerald-600';
  if (ms < 200) return 'text-yellow-600';
  return 'text-red-500';
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function getBackupBadgeConfig(
  backupMeta: BackupMeta,
  t: (key: string, params?: Record<string, string | number>) => string
) {
  const progress = t('session.backup.chunkProgress', {
    have: Math.min(backupMeta.remoteChunkCount, backupMeta.localChunkCount),
    total: backupMeta.localChunkCount,
  });

  switch (backupMeta.syncState) {
    case 'synced':
      return {
        label: t('session.backup.audioSafe'),
        detail: progress,
        containerClassName: 'bg-emerald-50 border-emerald-200 text-emerald-700',
        dotClassName: 'bg-emerald-500',
      };
    case 'syncing':
      return {
        label: t('session.backup.backingUp'),
        detail: progress,
        containerClassName: 'bg-sky-50 border-sky-200 text-sky-700',
        dotClassName: 'bg-sky-500',
      };
    case 'error':
      return {
        label: t('session.backup.backupRetry'),
        detail: progress,
        containerClassName: 'bg-red-50 border-red-200 text-red-700',
        dotClassName: 'bg-red-500',
      };
    case 'pending':
      return {
        label: t('session.backup.localSafe'),
        detail: progress,
        containerClassName: 'bg-amber-50 border-amber-200 text-amber-700',
        dotClassName: 'bg-amber-500',
      };
    default:
      return {
        label: t('session.backup.backupIdle'),
        detail: progress,
        containerClassName: 'bg-cream-50 border-cream-200 text-charcoal-500',
        dotClassName: 'bg-charcoal-300',
      };
  }
}

/* ─── Expandable Icon Button ─── */
function ExpandableButton({
  icon,
  label,
  onClick,
  disabled,
  variant = 'default',
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'danger' | 'default' | 'active';
  title?: string;
}) {
  const variants = {
    primary: 'bg-rust-500 text-white hover:bg-rust-600 shadow-sm shadow-rust-500/20',
    danger: 'bg-charcoal-800 text-white hover:bg-charcoal-700',
    default: 'border border-cream-300 text-charcoal-600 hover:bg-cream-50',
    active: 'bg-red-50 text-red-600 border border-red-200 hover:bg-red-100',
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`expand-btn flex items-center h-9 rounded-lg transition-all duration-200 overflow-hidden
                  ${variants[variant]} disabled:opacity-30 disabled:cursor-not-allowed`}
    >
      <span className="flex-shrink-0 w-9 h-9 flex items-center justify-center">
        {icon}
      </span>
      <span className="expand-label text-xs font-medium">
        {label}
      </span>
    </button>
  );
}

/* ─── Language Popover (compact globe button → dropdown) ─── */
/* ══════════════════════════════════════════════════ */
/*  MAIN PAGE                                        */
/* ══════════════════════════════════════════════════ */

export default function ActiveSessionPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.id as string;
  const isMobile = useIsMobile();
  const { t } = useI18n();

  const { restoreSession } = useAuth();
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const cachedQuotas = useAuthStore((s) => s.quotas);
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const pendingAutoStart = useSettingsStore((s) => s.pendingAutoStart);
  const setPendingAutoStart = useSettingsStore((s) => s.setPendingAutoStart);
  const clearPendingSessionTerms = useSettingsStore((s) => s.clearPendingSessionTerms);
  const setTerms = useSettingsStore((s) => s.setTerms);
  const translationMode = useSettingsStore((s) => s.translationMode);
  const targetLang = useSettingsStore((s) => s.targetLang);

  const recordingState = useTranscriptStore((s) => s.recordingState);
  const connectionState = useTranscriptStore((s) => s.connectionState);
  const connectionMeta = useTranscriptStore((s) => s.connectionMeta);
  const backupMeta = useTranscriptStore((s) => s.backupMeta);
  const recordingStartTime = useTranscriptStore((s) => s.recordingStartTime);
  const totalPausedMs = useTranscriptStore((s) => s.totalPausedMs);
  const pausedAt = useTranscriptStore((s) => s.pausedAt);
  const updateDuration = useTranscriptStore((s) => s.updateDuration);
  const segments = useTranscriptStore((s) => s.segments);
  const translations = useTranslationStore((s) => s.translations);
  const summaryBlocks = useSummaryStore((s) => s.blocks);
  const clearTranscript = useTranscriptStore((s) => s.clearAll);
  const clearTranslations = useTranslationStore((s) => s.clearAll);
  const clearSummaries = useSummaryStore((s) => s.clearAll);
  const { broadcaster, isSharing, shareToken, startSharing, stopSharing } = useLiveShare();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const pip = usePipReferenceTool();
  const [sessionTitle, setSessionTitle] = useState('New Lecture Session');
  const [sessionSourceLang, setSessionSourceLang] = useState('en');
  const [sessionTargetLang, setSessionTargetLang] = useState('zh');
  const [sessionMetaReady, setSessionMetaReady] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingTitle, setEditingTitle] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Ping data center latency（客户端直测）
  const [pingResults, setPingResults] = useState<ClientPingResult[] | null>(null);
  const [pinging, setPinging] = useState(false);
  const pingRunRef = useRef(false);
  const runPing = useCallback(async () => {
    if (pingRunRef.current) return;
    pingRunRef.current = true;
    setPinging(true);
    try {
      const results = await pingAllRegions();
      setPingResults(results);
      setCachedPingResults(results);
    } catch { /* silent */ }
    setPinging(false);
    pingRunRef.current = false;
  }, []);

  const loadQuotaSnapshot = useCallback(async (): Promise<UserQuotas | null> => {
    if (!token) {
      return null;
    }

    try {
      const response = await fetch('/api/users/quota', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as { quotas?: UserQuotas };
      if (!data.quotas) {
        return null;
      }

      setQuotaSnapshot(data.quotas);
      useAuthStore.getState().setQuotas(data.quotas);
      return data.quotas;
    } catch {
      return null;
    }
  }, [token]);

  const handleAutoPauseNotice = useCallback((reason: 'idle' | 'disconnect') => {
    if (reason === 'idle') {
      const message = t('session.notices.idleAutoPause');
      setBillingNotice({ tone: 'warning', message });
      if (typeof window !== 'undefined') {
        window.alert(message);
      }
      return;
    }

    setBillingNotice({
      tone: 'info',
      message: t('session.notices.disconnectPaused'),
    });
  }, [t]);

  const handleAutoResumeNotice = useCallback((reason: 'disconnect') => {
    if (reason !== 'disconnect') {
      return;
    }

    setBillingNotice({
      tone: 'info',
      message: t('session.notices.disconnectResumed'),
    });
  }, [t]);

  // v2.1: Finalization state
  const [isFinalizing, setIsFinalizing] = useState(false);
  const isFinalizingRef = useRef(false);
  const [finalizingSteps, setFinalizingSteps] = useState<FinalizingStep[]>([]);
  const [finalizingError, setFinalizingError] = useState<string | null>(null);
  const [quotaSnapshot, setQuotaSnapshot] = useState<UserQuotas | null>(cachedQuotas);
  const [billingNotice, setBillingNotice] = useState<{
    tone: 'info' | 'warning';
    message: string;
  } | null>(null);
  const quotaWarningShownRef = useRef(false);
  const quotaLimitReachedRef = useRef(false);
  const maxDurationReachedRef = useRef(false);
  const restoreAttemptedRef = useRef(false);
  const restoreInFlightRef = useRef(false);

  // v2.1: Route guard — redirect COMPLETED/ARCHIVED sessions to playback view
  const [sessionChecked, setSessionChecked] = useState(false);
  const [backendStatus, setBackendStatus] = useState<string | null>(null);
  useEffect(() => {
    if (user && token) return;
    // restoreSession 正在进行中：StrictMode 双调用或快速重渲染时，不能误跳 /login
    if (restoreInFlightRef.current) return;
    if (!restoreAttemptedRef.current) {
      restoreAttemptedRef.current = true;
      restoreInFlightRef.current = true;
      restoreSession().then((ok) => {
        restoreInFlightRef.current = false;
        if (!ok) {
          // zustand persist 可能已经水合了 token，再次检查
          const { user: u, token: t } = useAuthStore.getState();
          if (!u || !t) {
            router.replace('/login');
          }
        }
      });
      return;
    }
    // 同样 double-check，避免水合延迟导致误跳
    const { user: u, token: t } = useAuthStore.getState();
    if (!u || !t) {
      router.replace('/login');
    }
  }, [user, token, router, restoreSession]);

  useEffect(() => {
    if (!token || !sessionId) return;
    setSessionMetaReady(false);
    fetch(`/api/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.status === 'COMPLETED' || data.status === 'ARCHIVED') {
          router.replace(`/session/${sessionId}/playback`);
          return;
        }
        if (data.title) setSessionTitle(data.title);
        if (typeof data.sourceLang === 'string' && data.sourceLang) {
          setSessionSourceLang(data.sourceLang);
        }
        if (typeof data.targetLang === 'string' && data.targetLang) {
          setSessionTargetLang(data.targetLang);
        }
        setSessionMetaReady(true);
        setBackendStatus(data.status ?? null);
        setSessionChecked(true);
      })
      .catch(() => setSessionChecked(true));
  }, [token, sessionId, router]);

  // Service availability check on mount
  const [serviceAvailable, setServiceAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!token) return;
    fetch('/api/soniox/ping', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => setServiceAvailable(r.ok))
      .catch(() => setServiceAvailable(false));
  }, [token]);

  useEffect(() => {
    if (cachedQuotas) {
      setQuotaSnapshot(cachedQuotas);
    }
  }, [cachedQuotas]);

  useEffect(() => {
    if (!token) {
      return;
    }

    void loadQuotaSnapshot();
  }, [loadQuotaSnapshot, token]);

  // v2.1: Helper to sync session status with backend
  const syncSessionStatus = useCallback(async (status: SessionStatus) => {
    if (!token) return;
    try {
      await fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status }),
      });
    } catch {
      console.error(`Failed to sync session status to ${status}`);
    }
  }, [token, sessionId]);

  const maxSessionDurationMs = user
    ? getMaxSessionDurationMs(user.role)
    : null;
  const remainingQuotaMs =
    user?.role === 'ADMIN'
      ? null
      : quotaSnapshot
        ? (
            (quotaSnapshot.remainingTranscriptionMinutes ??
              Math.max(
                0,
                quotaSnapshot.transcriptionMinutesLimit -
                  quotaSnapshot.transcriptionMinutesUsed
              )) * 60_000
          )
        : null;

  // Timer
  const [elapsed, setElapsed] = useState(0);

  const {
    start: startRecording,
    stop: stopRecording,
    pause: pauseRecording,
    switchMicrophone,
    rebuildSession,
    reconnectAfterRefresh,
    finalizeRemoteDraft,
  } = useSoniox(sessionId, {
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    onAutoPause: handleAutoPauseNotice,
    onAutoResume: handleAutoResumeNotice,
  });
  const { initLocal, translateSentence, destroy: destroyTranslator } = useLocalTranslation();
  const { init: initSummary, onNewSentence, triggerManual, reset: resetSummary } = useSummary();
  const prevSegmentCountRef = useRef(0);
  const prevSummaryCountRef = useRef(0);
  const prevTranslationsRef = useRef<Record<string, string>>({});
  const prevShareStatusRef = useRef<string | null>(null);
  const liveSnapshotRef = useRef({
    segments,
    translations,
    summaryBlocks,
  });

  const getShareStatus = useCallback(() => {
    switch (recordingState) {
      case 'recording':
        return 'RECORDING';
      case 'paused':
        return 'PAUSED';
      case 'finalizing':
        return 'FINALIZING';
      case 'stopped':
        return 'COMPLETED';
      default:
        return 'CREATED';
    }
  }, [recordingState]);

  // Timer effect
  useEffect(() => {
    if (recordingState === 'recording' && recordingStartTime) {
      const tick = () => {
        const nextElapsed = Math.max(
          0,
          Date.now() - recordingStartTime - totalPausedMs
        );
        setElapsed(nextElapsed);
        updateDuration(nextElapsed);
      };

      tick();
      const interval = setInterval(() => {
        tick();
      }, 1000);
      return () => clearInterval(interval);
    }
    if (recordingState === 'paused' && recordingStartTime && pausedAt) {
      const nextElapsed = Math.max(
        0,
        pausedAt - recordingStartTime - totalPausedMs
      );
      setElapsed(nextElapsed);
      updateDuration(nextElapsed);
    }
  }, [pausedAt, recordingStartTime, recordingState, totalPausedMs, updateDuration]);

  // 初始化/清理 — 必须等 sessionStorage 水合完成后再决定是否清除
  const wasRecordingRef = useRef(false);
  const initDoneRef = useRef(false);
  useEffect(() => {
    let cancelled = false;

    waitForTranscriptHydration().then(() => {
      if (cancelled) return;
      initDoneRef.current = true;

      const storeState = useTranscriptStore.getState();
      const isResumable = storeState.recordingState === 'recording' ||
                          storeState.recordingState === 'paused';
      // 如果 recordingState 是 'stopped' 且还有数据，说明是 FINALIZING 期间刷新的，不能清除
      const hasDataAfterStop = storeState.recordingState === 'stopped' &&
                               storeState.segments.length > 0;
      wasRecordingRef.current = isResumable;

      if (!isResumable && !hasDataAfterStop) {
        clearTranscript();
        clearTranslations();
        clearSummaries();
      }
      initSummary();
    });

    return () => {
      cancelled = true;
      resetSummary();
      // 只在非录音状态时清除（避免刷新时丢数据）
      // FINALIZING 期间也不能清除 — 否则刷新会丢失所有数据
      const currentState = useTranscriptStore.getState().recordingState;
      if ((currentState === 'idle' || currentState === 'stopped') && !isFinalizingRef.current) {
        clearTranscript();
        clearTranslations();
        clearSummaries();
      }
    };
  }, [sessionId, clearTranscript, clearTranslations, clearSummaries, initSummary, resetSummary]);

  // 从后端恢复草稿数据（浏览器关闭后重新打开的冷恢复场景）
  const draftRestorationDoneRef = useRef(false);
  useEffect(() => {
    if (draftRestorationDoneRef.current) return;
    if (!sessionChecked || !token || !sessionId) return;
    // 在会话状态为 PAUSED、RECORDING 或 FINALIZING 时尝试恢复
    // FINALIZING：用户可能在结束录制后刷新了页面，需要从后端 draft 恢复数据
    if (backendStatus !== 'PAUSED' && backendStatus !== 'RECORDING' && backendStatus !== 'FINALIZING') return;
    // 如果 store 已经有数据（从 sessionStorage 恢复的页面刷新场景），无需从后端拉取
    if (useTranscriptStore.getState().segments.length > 0) return;

    draftRestorationDoneRef.current = true;

    (async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/transcript/draft?full=true`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!data.exists || !data.payload) return;

        const draft = data.payload;
        const draftSegments = Array.isArray(draft.segments) ? draft.segments : [];
        if (draftSegments.length === 0) return;

        // 恢复转录数据
        const tStore = useTranscriptStore.getState();
        for (const seg of draftSegments) {
          tStore.addFinalSegment(seg);
        }

        // 恢复录音时间信息 — 构建合理的时间戳使计时器显示正确的累计时长
        const lastSeg = draftSegments[draftSegments.length - 1];
        const durationMs = typeof draft.totalDurationMs === 'number'
          ? draft.totalDurationMs
          : (lastSeg?.globalEndMs ?? 0);
        const now = Date.now();
        tStore.setRecordingStartTime(now - durationMs);
        tStore.setPausedAt(now);
        tStore.setRecordingState('paused');
        tStore.updateDuration(durationMs);
        if (typeof draft.currentSessionIndex === 'number') {
          tStore.setCurrentSessionIndex(draft.currentSessionIndex);
        }

        // 恢复摘要数据
        const draftSummaries = Array.isArray(draft.summaries) ? draft.summaries : [];
        if (draftSummaries.length > 0) {
          const sStore = useSummaryStore.getState();
          for (const block of draftSummaries) {
            sStore.addBlock(block);
          }
          if (typeof draft.summaryRunningContext === 'string') {
            sStore.updateRunningContext(draft.summaryRunningContext);
          }
        }

        // 恢复翻译数据
        if (draft.translations && typeof draft.translations === 'object') {
          const trStore = useTranslationStore.getState();
          for (const [id, text] of Object.entries(draft.translations)) {
            trStore.setTranslation(id, text as string);
          }
        }

        console.log(`从后端草稿恢复了 ${draftSegments.length} 个转录段落`);
      } catch (err) {
        console.error('从后端恢复草稿失败:', err);
      }
    })();
  }, [sessionChecked, token, sessionId, backendStatus]);

  // FINALIZING 恢复：刷新后检测到 FINALIZING 状态时，轮询等待完成并跳转回放
  useEffect(() => {
    if (!sessionChecked || !token || !sessionId) return;
    if (backendStatus !== 'FINALIZING') return;
    // 如果是当前录制触发的 finalize，不重复处理（handleStopWithFinalization 会自行跳转）
    if (isFinalizingRef.current) return;

    // 说明是刷新后检测到的 FINALIZING — 显示 finalize 遮罩并轮询
    isFinalizingRef.current = true;
    setIsFinalizing(true);
    setFinalizingSteps([
      { label: t('session.finalizing.stepStop'), status: 'done' },
      { label: t('session.finalizing.stepSync'), status: 'done' },
      { label: t('session.finalizing.stepFinalize'), status: 'active' },
    ]);

    let retried = false;
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === 'COMPLETED' || data.status === 'ARCHIVED') {
          clearInterval(poll);
          setFinalizingSteps([
            { label: t('session.finalizing.stepStop'), status: 'done' },
            { label: t('session.finalizing.stepSync'), status: 'done' },
            { label: t('session.finalizing.stepFinalize'), status: 'done' },
          ]);
          // 清除本地缓存
          try {
            sessionStorage.removeItem('lecture-live-transcript');
            sessionStorage.removeItem('lecture-live-translations');
            sessionStorage.removeItem('lecture-live-summary');
          } catch { /* silent */ }
          setTimeout(() => router.push(`/session/${sessionId}/playback`), 600);
        } else if (data.status === 'FINALIZING' && !retried) {
          // 可能 finalize 请求被刷新中断 — 超时后自动重试一次
          retried = true;
          fetch(`/api/sessions/${sessionId}/finalize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({}),
          }).catch(() => { /* server-side draft 是主要数据源，空 body 即可 */ });
        }
      } catch { /* 网络错误 — 继续轮询 */ }
    }, 3000);

    return () => clearInterval(poll);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionChecked, token, sessionId, backendStatus]);

  useEffect(() => {
    if (translationMode === 'local' || translationMode === 'both') {
      initLocal();
    }
    return () => destroyTranslator();
  }, [translationMode, initLocal, destroyTranslator]);

  useEffect(() => {
    if (segments.length === 0) return;
    const latestSegment = segments[segments.length - 1];
    onNewSentence(latestSegment.text);
    if (translationMode === 'local' || translationMode === 'both') {
      translateSentence(latestSegment.id, latestSegment.text, latestSegment.language);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments.length]);

  // v2.1: Sync recording state changes to backend
  useEffect(() => {
    if (!sessionChecked) return;
    if (finalizingError) return;
    if (recordingState === 'recording') {
      syncSessionStatus('RECORDING');
    } else if (recordingState === 'paused') {
      syncSessionStatus('PAUSED');
    }
  }, [finalizingError, recordingState, sessionChecked, syncSessionStatus]);

  // 录制期间每 15 秒自动上传转录稿草稿到服务器
  const transcriptDraftTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastDraftSegCountRef = useRef(0);
  useEffect(() => {
    if (transcriptDraftTimerRef.current) {
      clearInterval(transcriptDraftTimerRef.current);
      transcriptDraftTimerRef.current = null;
    }

    if (
      (recordingState !== 'recording' && recordingState !== 'paused') ||
      !token ||
      !sessionId
    ) {
      return;
    }

    const uploadDraft = async () => {
      const currentSegments = useTranscriptStore.getState().segments;
      // 没有新 segment 时跳过
      if (currentSegments.length === 0 || currentSegments.length === lastDraftSegCountRef.current) {
        return;
      }
      lastDraftSegCountRef.current = currentSegments.length;

      const summaryState = useSummaryStore.getState();
      const currentSummaries = summaryState.blocks;
      const currentTranslations = useTranslationStore.getState().translations;
      const tState = useTranscriptStore.getState();

      try {
        await fetch(`/api/sessions/${sessionId}/transcript/draft`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          keepalive: true,
          body: JSON.stringify({
            segments: currentSegments,
            summaries: currentSummaries,
            translations: currentTranslations,
            clientTs: Date.now(),
            recordingStartTime: tState.recordingStartTime,
            pausedAt: tState.pausedAt,
            totalPausedMs: tState.totalPausedMs,
            totalDurationMs: tState.totalDurationMs,
            summaryRunningContext: summaryState.runningContext,
            currentSessionIndex: tState.currentSessionIndex,
          }),
        });
      } catch {
        // 静默失败，下次重试
      }
    };

    // 启动后立即上传一次，然后每 15 秒一次
    void uploadDraft();
    transcriptDraftTimerRef.current = setInterval(() => void uploadDraft(), 15_000);

    return () => {
      if (transcriptDraftTimerRef.current) {
        clearInterval(transcriptDraftTimerRef.current);
        transcriptDraftTimerRef.current = null;
      }
    };
  }, [recordingState, token, sessionId]);

  useEffect(() => {
    liveSnapshotRef.current = {
      segments,
      translations,
      summaryBlocks,
    };
  }, [segments, translations, summaryBlocks]);

  useEffect(() => {
    if (!isSharing || !broadcaster) {
      prevSegmentCountRef.current = 0;
      prevSummaryCountRef.current = 0;
      prevTranslationsRef.current = {};
      prevShareStatusRef.current = null;
      return;
    }

    broadcaster.syncSnapshot({
      segments: liveSnapshotRef.current.segments,
      translations: liveSnapshotRef.current.translations,
      summaryBlocks: liveSnapshotRef.current.summaryBlocks,
      status: getShareStatus(),
      previewText: useTranscriptStore.getState().currentPreviewText,
      previewTranslation: useTranscriptStore.getState().currentPreviewTranslationText,
    });
    prevSegmentCountRef.current = liveSnapshotRef.current.segments.length;
    prevSummaryCountRef.current = liveSnapshotRef.current.summaryBlocks.length;
    prevTranslationsRef.current = { ...liveSnapshotRef.current.translations };
    prevShareStatusRef.current = getShareStatus();
  }, [isSharing, broadcaster, getShareStatus]);

  useEffect(() => {
    if (!isSharing || !broadcaster) return;
    if (segments.length < prevSegmentCountRef.current) {
      prevSegmentCountRef.current = segments.length;
      return;
    }
    if (segments.length === prevSegmentCountRef.current) return;

    segments.slice(prevSegmentCountRef.current).forEach((segment) => {
      broadcaster.broadcastTranscriptDelta(segment);
    });
    prevSegmentCountRef.current = segments.length;
  }, [segments, isSharing, broadcaster]);

  useEffect(() => {
    if (!isSharing || !broadcaster) return;
    if (summaryBlocks.length < prevSummaryCountRef.current) {
      prevSummaryCountRef.current = summaryBlocks.length;
      return;
    }
    if (summaryBlocks.length === prevSummaryCountRef.current) return;

    summaryBlocks.slice(prevSummaryCountRef.current).forEach((block) => {
      broadcaster.broadcastSummaryUpdate(block);
    });
    prevSummaryCountRef.current = summaryBlocks.length;
  }, [summaryBlocks, isSharing, broadcaster]);

  useEffect(() => {
    if (!isSharing || !broadcaster) return;

    const previousTranslations = prevTranslationsRef.current;
    Object.entries(translations).forEach(([segmentId, translation]) => {
      if (previousTranslations[segmentId] !== translation) {
        broadcaster.broadcastTranslationDelta(segmentId, translation);
      }
    });
    prevTranslationsRef.current = { ...translations };
  }, [translations, isSharing, broadcaster]);

  useEffect(() => {
    if (!isSharing || !broadcaster) return;
    const status = getShareStatus();
    if (prevShareStatusRef.current === status) return;
    broadcaster.broadcastStatusUpdate(status);
    prevShareStatusRef.current = status;
  }, [recordingState, isSharing, broadcaster, getShareStatus]);

  // 广播实时预览文本（节流：最多 150ms 一次，避免高频 WebSocket 消息）
  // 使用 Zustand subscribe 直接监听 store 变化，不依赖 React 渲染周期
  useEffect(() => {
    if (!isSharing || !broadcaster) return;

    let throttleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPreview = useTranscriptStore.getState().currentPreviewText;
    let lastPreviewTranslation =
      useTranscriptStore.getState().currentPreviewTranslationText;
    let pending: {
      previewText: typeof lastPreview;
      previewTranslation: typeof lastPreviewTranslation;
    } | null = null;

    const unsubscribe = useTranscriptStore.subscribe((state) => {
      const previewUnchanged =
        state.currentPreviewText.finalText === lastPreview.finalText &&
        state.currentPreviewText.nonFinalText === lastPreview.nonFinalText;
      const previewTranslationUnchanged =
        state.currentPreviewTranslationText.finalText ===
          lastPreviewTranslation.finalText &&
        state.currentPreviewTranslationText.nonFinalText ===
          lastPreviewTranslation.nonFinalText &&
        state.currentPreviewTranslationText.state ===
          lastPreviewTranslation.state &&
        state.currentPreviewTranslationText.sourceLanguage ===
          lastPreviewTranslation.sourceLanguage;
      if (previewUnchanged && previewTranslationUnchanged) return;

      lastPreview = state.currentPreviewText;
      lastPreviewTranslation = state.currentPreviewTranslationText;
      pending = {
        previewText: lastPreview,
        previewTranslation: lastPreviewTranslation,
      };
      if (!throttleTimer) {
        broadcaster.broadcastPreviewUpdate(pending);
        pending = null;
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
          if (pending) {
            broadcaster.broadcastPreviewUpdate(pending);
            pending = null;
          }
        }, 150);
      }
    });

    return () => {
      unsubscribe();
      if (throttleTimer) clearTimeout(throttleTimer);
    };
  }, [isSharing, broadcaster]);

  // v2.2: 服务端 finalize — 客户端只负责停止录音 + 发信号，服务端从 draft 完成所有持久化
  const handleStopWithFinalization = useCallback(async () => {
    setIsFinalizing(true);
    isFinalizingRef.current = true;
    setFinalizingError(null);
    const steps: FinalizingStep[] = [
      { label: t('session.finalizing.stepStop'), status: 'active' },
      { label: t('session.finalizing.stepSync'), status: 'pending' },
      { label: t('session.finalizing.stepFinalize'), status: 'pending' },
    ];
    setFinalizingSteps([...steps]);

    const failFinalization = (index: number, message: string) => {
      const safeIndex = index >= 0 ? index : steps.length - 1;
      steps[safeIndex].status = 'error';
      setFinalizingSteps([...steps]);
      setFinalizingError(message);
      setIsFinalizing(false);
    };

    try {
      if (!token) {
        throw new Error(t('session.finalizing.missingToken'));
      }

      // ── Step 1: 停止 Soniox 和本地录音 ──
      await syncSessionStatus('FINALIZING');
      await stopRecording();
      steps[0].status = 'done';
      steps[1].status = 'active';
      setFinalizingSteps([...steps]);

      // ── Step 2: Best-effort 最终同步（确保服务端 draft 是最新的）──
      const transcriptSegments = useTranscriptStore.getState().segments;
      const summaryBlocks = useSummaryStore.getState().blocks;
      const translationEntries = useTranslationStore.getState().translations;

      // 并行：上传最新转录 draft + 同步剩余音频 chunks
      await Promise.allSettled([
        fetch(`/api/sessions/${sessionId}/transcript/draft`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          keepalive: true,
          body: JSON.stringify({
            segments: transcriptSegments,
            summaries: summaryBlocks,
            translations: translationEntries,
            clientTs: Date.now(),
          }),
        }),
        finalizeRemoteDraft().catch(() => false),
      ]);

      steps[1].status = 'done';
      steps[2].status = 'active';
      setFinalizingSteps([...steps]);

      // ── Step 3: 调用服务端 finalize（一个请求完成所有持久化 + COMPLETED）──
      // 同时把客户端最新数据带上，作为 draft 的补充/覆盖
      const finalizeRes = await fetch(`/api/sessions/${sessionId}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          segments: transcriptSegments,
          summaries: summaryBlocks,
          translations: translationEntries,
          durationMs: elapsed,
          title: sessionTitle,
        }),
      });
      if (!finalizeRes.ok) {
        const data = await finalizeRes.json().catch(() => ({}));
        throw new Error(
          typeof data.error === 'string' ? data.error : t('session.finalizing.failed')
        );
      }

      // 录制完成后自动停止分享，但保留链接供回放访问
      if (isSharing) {
        await stopSharing(sessionId, { keepForPlayback: true });
      }

      steps[2].status = 'done';
      setFinalizingSteps([...steps]);
      clearPendingSessionTerms();

      // 清除本地缓存（已由服务端持久化）
      try {
        sessionStorage.removeItem('lecture-live-transcript');
        sessionStorage.removeItem('lecture-live-translations');
        sessionStorage.removeItem('lecture-live-summary');
        sessionStorage.removeItem('lecture-live-archive-mime');
      } catch { /* silent */ }
      try {
        const { clearAudioChunks } = await import('@/lib/audio/audioChunkStore');
        await clearAudioChunks(sessionId);
      } catch { /* silent */ }

      setTimeout(() => {
        router.push(`/session/${sessionId}/playback`);
      }, 800);
    } catch (error) {
      failFinalization(
        steps.findIndex((step) => step.status === 'active'),
        error instanceof Error ? error.message : t('session.finalizing.failed')
      );
      isFinalizingRef.current = false;
      const store = useTranscriptStore.getState();
      store.setConnectionState('error');
      store.setRecordingState('paused');
    }
  }, [
    stopRecording,
    syncSessionStatus,
    sessionId,
    token,
    elapsed,
    sessionTitle,
    router,
    finalizeRemoteDraft,
    clearPendingSessionTerms,
    isSharing,
    stopSharing,
    t,
  ]);

  const handleStartRecording = useCallback(async () => {
    setBillingNotice(null);

    if (recordingState === 'paused') {
      await startRecording();
      return;
    }

    const latestQuota = await loadQuotaSnapshot();
    const remainingMinutes =
      user?.role === 'ADMIN'
        ? Number.POSITIVE_INFINITY
        : latestQuota?.remainingTranscriptionMinutes ??
          (latestQuota
            ? Math.max(
                0,
                latestQuota.transcriptionMinutesLimit -
                  latestQuota.transcriptionMinutesUsed
              )
            : null);

    if (
      user?.role !== 'ADMIN' &&
      remainingMinutes != null &&
      remainingMinutes <= 0
    ) {
      setBillingNotice({
        tone: 'warning',
        message: t('session.notices.quotaExhaustedStart'),
      });
      return;
    }

    quotaWarningShownRef.current = false;
    quotaLimitReachedRef.current = false;
    maxDurationReachedRef.current = false;

    void syncSessionStatus('RECORDING');
    await startRecording();
  }, [
    loadQuotaSnapshot,
    recordingState,
    startRecording,
    syncSessionStatus,
    user?.role,
    t,
  ]);

  useEffect(() => {
    if (recordingState !== 'recording' || isFinalizing) {
      return;
    }

    if (
      maxSessionDurationMs != null &&
      elapsed >= maxSessionDurationMs &&
      !maxDurationReachedRef.current
    ) {
      maxDurationReachedRef.current = true;
      setBillingNotice({
        tone: 'warning',
        message: t('session.notices.maxDurationReached', {
          duration: formatDuration(maxSessionDurationMs),
        }),
      });
      void handleStopWithFinalization();
      return;
    }

    if (remainingQuotaMs == null) {
      return;
    }

    const remainingBeforeStopMs = remainingQuotaMs - elapsed;
    if (
      remainingBeforeStopMs > 0 &&
      remainingBeforeStopMs <= QUOTA_WARNING_LEAD_MS &&
      !quotaWarningShownRef.current
    ) {
      quotaWarningShownRef.current = true;
      setBillingNotice({
        tone: 'warning',
        message: t('session.notices.lowQuotaWarning', {
          minutes: Math.max(1, Math.ceil(remainingBeforeStopMs / 60_000)),
        }),
      });
    }

    if (remainingBeforeStopMs <= 0 && !quotaLimitReachedRef.current) {
      quotaLimitReachedRef.current = true;
      setBillingNotice({
        tone: 'warning',
        message: t('session.notices.quotaExhaustedStop'),
      });
      void handleStopWithFinalization();
    }
  }, [
    elapsed,
    handleStopWithFinalization,
    isFinalizing,
    maxSessionDurationMs,
    recordingState,
    remainingQuotaMs,
    t,
  ]);

  // Auto-start recording
  const autoStartFired = useRef(false);
  useEffect(() => {
    if (pendingAutoStart && !autoStartFired.current && recordingState === 'idle' && sessionChecked) {
      autoStartFired.current = true;
      setPendingAutoStart(false);
      void handleStartRecording();
    }
  }, [handleStartRecording, pendingAutoStart, recordingState, setPendingAutoStart, sessionChecked]);

  // 刷新后自动恢复录音 — 检测到 store 中有录音状态但无活跃连接时自动重连
  const refreshReconnectFired = useRef(false);
  useEffect(() => {
    if (refreshReconnectFired.current) return;
    if (!token || !sessionChecked) return;
    if (!wasRecordingRef.current) return;
    // Store 有录音状态但连接已断开 → 刷新恢复场景
    const storeState = useTranscriptStore.getState();
    if ((storeState.recordingState === 'recording' || storeState.recordingState === 'paused') &&
        storeState.connectionState === 'disconnected') {
      refreshReconnectFired.current = true;
      console.log('Detected refresh during recording, auto-reconnecting...');
      reconnectAfterRefresh();
    }
  }, [token, sessionChecked, reconnectAfterRefresh]);

  // Title editing
  const handleStartEditTitle = useCallback(() => {
    setEditingTitle(sessionTitle);
    setIsEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  }, [sessionTitle]);

  const handleConfirmTitle = useCallback(() => {
    const trimmed = editingTitle.trim();
    if (trimmed) setSessionTitle(trimmed);
    setIsEditingTitle(false);
  }, [editingTitle]);

  const handleInjectKeywords = useCallback(async (keywords: string[]) => {
    if (keywords.length === 0) {
      return;
    }

    const settings = useSettingsStore.getState();
    const updatedManualTerms = mergeSessionTerms({
      sessionKeywords: [...settings.terms, ...keywords],
    });
    const updatedSessionTerms = mergeSessionTerms({
      sessionKeywords: [...settings.getSessionConfig(sessionId).terms, ...keywords],
    });

    setTerms(updatedManualTerms);
    settings.setPendingSessionTerms(sessionId, updatedSessionTerms);

    if (recordingState === 'recording' || recordingState === 'paused') {
      await rebuildSession();
      if (recordingState === 'paused') {
        pauseRecording();
      }
    }
  }, [pauseRecording, recordingState, rebuildSession, sessionId, setTerms]);

  const isRecording = recordingState === 'recording';
  const isPaused = recordingState === 'paused';
  const isFinalizingRec = recordingState === 'finalizing';
  const isStopped = recordingState === 'stopped';
  const isIdle = recordingState === 'idle';
  const isActive = isRecording || isPaused || isFinalizingRec;
  const hasPendingSave = Boolean(finalizingError);
  const shouldShowBackupBadge =
    (isActive || hasPendingSave || backupMeta.localChunkCount > 0) &&
    !(isStopped && !hasPendingSave);
  const backupBadge = getBackupBadgeConfig(backupMeta, t);
  const backupTooltip = backupMeta.localChunkCount > 0
    ? t('session.backup.serverTooltip', {
        have: Math.min(
          backupMeta.remoteChunkCount,
          backupMeta.localChunkCount
        ),
        total: backupMeta.localChunkCount,
      })
    : t('session.backup.idleTooltip');
  const backupTitle = backupMeta.lastError
    ? `${backupTooltip} ${backupMeta.lastError}`
    : backupTooltip;
  const shareUrl =
    typeof window !== 'undefined' && shareToken
      ? `${window.location.origin}/session/${sessionId}/view?token=${shareToken}`
      : null;

  const handleToggleMobileShare = useCallback(async () => {
    if (isSharing) {
      await stopSharing(sessionId);
      return;
    }

    try {
      await startSharing(sessionId);
    } catch {
      // silent
    }
  }, [isSharing, sessionId, startSharing, stopSharing]);

  const handleCopyShareLink = useCallback(async () => {
    if (!shareUrl) {
      return;
    }

    await navigator.clipboard.writeText(shareUrl);
  }, [shareUrl]);

  if (!user || !token) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-cream-50">
        <div className="text-charcoal-400 text-sm">{t('session.redirectingToLogin')}</div>
      </div>
    );
  }

  if (isMobile) {
    return (
      <>
        {billingNotice && (
          <div
            className={`fixed inset-x-0 top-0 z-50 px-4 py-2 text-xs ${
              billingNotice.tone === 'warning'
                ? 'bg-amber-50 text-amber-800 border-b border-amber-200'
                : 'bg-sky-50 text-sky-800 border-b border-sky-200'
            }`}
          >
            {billingNotice.message}
          </div>
        )}
        <MobileSessionLayout
          sessionId={sessionId}
          sessionTitle={sessionTitle}
          isEditingTitle={isEditingTitle}
          editingTitle={editingTitle}
          titleInputRef={titleInputRef}
          onStartEditTitle={handleStartEditTitle}
          onConfirmTitle={handleConfirmTitle}
          onCancelTitleEdit={() => setIsEditingTitle(false)}
          onEditTitleChange={setEditingTitle}
          recordingState={recordingState}
          connectionState={connectionState}
          connectionMeta={connectionMeta}
          elapsed={elapsed}
          backupMeta={backupMeta}
          serviceAvailable={serviceAvailable}
          hasPendingSave={hasPendingSave}
          hasTranslation={Boolean(targetLang)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenExport={() => setExportOpen(true)}
          onToggleShare={handleToggleMobileShare}
          onCopyShareLink={handleCopyShareLink}
          onTogglePip={pip.toggle}
          isSharing={isSharing}
          shareUrl={shareUrl}
          pipOpen={pip.isOpen}
          onStart={() => {
            void handleStartRecording();
          }}
          onPause={pauseRecording}
          onResume={handleStartRecording}
          onStop={handleStopWithFinalization}
          onRetry={handleStopWithFinalization}
          onViewPlayback={() => router.push(`/session/${sessionId}/playback`)}
          onManualSummary={triggerManual}
          onInjectKeywords={handleInjectKeywords}
        />

        <SettingsDrawer
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSwitchMic={switchMicrophone}
          onSettingsApplied={rebuildSession}
        />
        <ExportModal
          isOpen={exportOpen}
          onClose={() => setExportOpen(false)}
          sessionTitle={sessionMetaReady ? sessionTitle : ''}
          sessionId={sessionId}
          sourceLang={sessionMetaReady ? sessionSourceLang : undefined}
          targetLang={sessionMetaReady ? sessionTargetLang : undefined}
          segments={segments}
          translations={translations}
          summaries={summaryBlocksToResponses(summaryBlocks)}
        />
        <SessionFinalizingOverlay steps={finalizingSteps} visible={isFinalizing} />

        {pip.isOpen && pip.mode === 'document-pip' && pip.pipWindow && (
          <PipPortal
            pipWindow={pip.pipWindow}
            pinned={pip.pinned}
            onTogglePin={() => pip.setPinned(!pip.pinned)}
            onClose={pip.close}
          />
        )}
        {pip.isOpen && pip.mode === 'video-pip' && (
          <VideoPipBridge updateData={pip.videoPipUpdate} />
        )}
        {pip.isOpen && pip.mode === 'inline' && (
          <InlinePipPanel
            pinned={pip.pinned}
            onTogglePin={() => pip.setPinned(!pip.pinned)}
            onClose={pip.close}
          />
        )}
      </>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <UserSettingsModal />

      <main
        className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${
          sidebarCollapsed ? 'ml-16' : 'ml-56'
        }`}
      >
        {/* ── Header ── */}
        <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-cream-200">
          {finalizingError && (
            <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-xs text-red-700">
              {finalizingError}
            </div>
          )}
          {billingNotice && (
            <div
              className={`border-b px-5 py-2 text-xs ${
                billingNotice.tone === 'warning'
                  ? 'border-amber-200 bg-amber-50 text-amber-800'
                  : 'border-sky-200 bg-sky-50 text-sky-800'
              }`}
            >
              {billingNotice.message}
            </div>
          )}
          <div className="flex items-center justify-between px-5 py-2.5 gap-4">

            {/* ── Left: Title + Status badge (with latency) + Live badge ── */}
            <div className="flex items-center gap-2.5 min-w-0 shrink">
              {isEditingTitle ? (
                <div className="flex items-center gap-1.5">
                  <input
                    ref={titleInputRef}
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleConfirmTitle();
                      if (e.key === 'Escape') setIsEditingTitle(false);
                    }}
                    onBlur={handleConfirmTitle}
                    className="font-serif font-bold text-charcoal-800 text-base leading-tight
                               bg-transparent border-b-2 border-rust-400 outline-none
                               w-[260px]"
                    autoFocus
                  />
                  <button
                    onClick={handleConfirmTitle}
                    className="w-6 h-6 flex items-center justify-center rounded-md
                               bg-rust-500 text-white hover:bg-rust-600 transition-colors flex-shrink-0"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleStartEditTitle}
                  className="group flex items-center gap-1.5 hover:bg-cream-50 rounded-lg px-2 py-1 transition-colors min-w-0"
                >
                  <h1 className="font-serif font-bold text-charcoal-800 text-base leading-tight truncate max-w-[220px]">
                    {sessionTitle}
                  </h1>
                  <Pencil className="w-3 h-3 text-charcoal-300 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                </button>
              )}

              {/* Combined status badge — double row: REC+time / latency */}
              {isActive && (() => {
                const isConnected = connectionState === 'connected';
                const isConnecting = connectionState === 'connecting' || connectionState === 'reconnecting';
                const isError = connectionState === 'error';
                const actuallyRecording = isRecording && isConnected;
                const showConnecting = isRecording && isConnecting;

                // Determine badge color based on real connection state
                const badgeBg = isError
                  ? 'bg-red-50 border-red-200'
                  : showConnecting
                    ? 'bg-amber-50 border-amber-200'
                    : actuallyRecording
                      ? 'bg-red-50 border-red-200'
                      : 'bg-yellow-50 border-yellow-200';
                const badgeText = isError
                  ? 'text-red-600'
                  : showConnecting
                    ? 'text-amber-700'
                    : actuallyRecording
                      ? 'text-red-700'
                      : 'text-yellow-700';
                const dotColor = isError
                  ? 'bg-red-500'
                  : showConnecting
                    ? 'bg-amber-500'
                    : actuallyRecording
                      ? 'bg-red-500'
                      : 'bg-yellow-500';
                const stateLabel = isError
                  ? t('session.status.error')
                  : showConnecting
                    ? t('session.status.connecting')
                    : actuallyRecording
                      ? t('session.status.recording')
                      : isPaused
                        ? t('session.status.paused')
                        : t('session.status.waiting');

                return (
                  <div className="relative group/status">
                    <div className={`flex items-center gap-2 px-2.5 py-1 rounded-lg border whitespace-nowrap ${badgeBg} ${badgeText}`}>
                      {/* Dot */}
                      <span className="relative flex h-2 w-2 flex-shrink-0">
                        {(actuallyRecording || showConnecting) && (
                          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-40 ${dotColor}`} />
                        )}
                        <span className={`relative inline-flex rounded-full h-2 w-2 ${dotColor}`} />
                      </span>

                      {/* Two rows */}
                      <div className="flex flex-col leading-tight">
                        {/* Row 1: state + time */}
                        <span className="text-[11px] font-semibold tracking-wide">
                          {stateLabel}
                          <span className="font-mono tabular-nums font-medium opacity-75 ml-1.5">
                            {formatDuration(elapsed)}
                          </span>
                        </span>
                        {/* Row 2: latency or connection hint */}
                        <span className="text-[10px] opacity-70">
                          {isError ? (
                            t('session.status.connectionFailed')
                          ) : showConnecting ? (
                            t('session.status.establishingConnection')
                          ) : connectionMeta.transcriptionLatencyMs != null && connectionMeta.transcriptionLatencyMs > 0 ? (
                            <span className={`font-mono ${latencyColor(connectionMeta.transcriptionLatencyMs)}`}>
                              {connectionMeta.transcriptionLatencyMs < 1000
                                ? `${connectionMeta.transcriptionLatencyMs}ms`
                                : `${(connectionMeta.transcriptionLatencyMs / 1000).toFixed(1)}s`}
                              {connectionMeta.region && (
                                <span className="ml-1 opacity-60">{connectionMeta.region.toUpperCase()}</span>
                              )}
                            </span>
                          ) : connectionMeta.latencyMs != null ? (
                            <span className={`font-mono ${latencyColor(connectionMeta.latencyMs)}`}>
                              {connectionMeta.latencyMs}ms
                              {connectionMeta.region && (
                                <span className="ml-1 opacity-60">{connectionMeta.region.toUpperCase()}</span>
                              )}
                            </span>
                          ) : (
                            t('session.status.measuringLatency')
                          )}
                        </span>
                      </div>
                    </div>

                    {/* Latency hover tooltip with data center pings */}
                    <div
                      className="absolute top-full left-0 pt-2 z-50
                                 opacity-0 invisible translate-y-1
                                 group-hover/status:opacity-100 group-hover/status:visible group-hover/status:translate-y-0
                                 transition-all duration-200 ease-out"
                    >
                    <div
                      className="w-52 bg-white border border-cream-200 rounded-xl shadow-xl overflow-hidden"
                      onMouseEnter={() => { if (!pingResults) runPing(); }}
                    >
                      {/* Header: current connection info */}
                      <div className="px-3 py-2 bg-cream-50/80 border-b border-cream-100">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-charcoal-500">
                            {isError
                              ? t('session.status.error')
                              : showConnecting
                                ? t('session.status.connecting')
                                : isRecording
                                  ? t('session.status.recording')
                                  : t('session.status.paused')}
                          </span>
                          <span className={`font-mono font-bold ${latencyColor(
                            connectionMeta.transcriptionLatencyMs ?? connectionMeta.latencyMs
                          )}`}>
                            {connectionMeta.transcriptionLatencyMs != null && connectionMeta.transcriptionLatencyMs > 0
                              ? (connectionMeta.transcriptionLatencyMs < 1000
                                  ? `${connectionMeta.transcriptionLatencyMs}ms`
                                  : `${(connectionMeta.transcriptionLatencyMs / 1000).toFixed(1)}s`)
                              : connectionMeta.latencyMs != null
                                ? `${connectionMeta.latencyMs}ms`
                                : '—'}
                          </span>
                        </div>
                        {connectionMeta.region && (
                          <div className="flex items-center gap-1 text-[10px] text-charcoal-400 mt-0.5">
                            <FlagImg code={connectionMeta.region} type="region" size={12} />
                            <span>{getRegionLabel(connectionMeta.region, t)}</span>
                            {connectionMeta.connectedAt && (
                              <span className="ml-1.5 font-mono">· {formatUptime(Date.now() - connectionMeta.connectedAt)}</span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Data center latency list */}
                      <div className="px-3 py-2">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[9px] font-semibold text-charcoal-400 uppercase tracking-wider">
                            {t('session.status.browserToDatacenter')}
                          </span>
                          <button
                            onClick={(e) => { e.stopPropagation(); setPingResults(null); runPing(); }}
                            disabled={pinging}
                            className="text-[9px] text-rust-500 hover:text-rust-600 font-medium disabled:opacity-40
                                       flex items-center gap-0.5"
                          >
                            {pinging ? (
                              <Loader2 className="w-2.5 h-2.5 animate-spin" />
                            ) : (
                              <RefreshCw className="w-2.5 h-2.5" />
                            )}
                          </button>
                        </div>

                        {pinging && !pingResults ? (
                          <div className="flex items-center justify-center gap-1.5 py-2 text-charcoal-400">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span className="text-[10px]">{t('session.status.measuring')}</span>
                          </div>
                        ) : (
                          <div className="space-y-1">
                            {(pingResults || []).map((r) => {
                              const isCurrent = connectionMeta.region === r.region && connectionState === 'connected';
                              return (
                                <div
                                  key={r.region}
                                  className={`flex items-center justify-between px-2 py-1 rounded-md text-[10px]
                                             ${isCurrent
                                               ? 'bg-emerald-50 border border-emerald-200'
                                               : 'bg-cream-50 border border-cream-100'
                                             }`}
                                >
                                  <div className="flex items-center gap-1.5">
                                    <FlagImg code={r.region} type="region" size={14} />
                                    <span className={`font-medium ${isCurrent ? 'text-emerald-700' : 'text-charcoal-600'}`}>
                                      {r.region.toUpperCase()}
                                      {isCurrent && (
                                        <span className="ml-1 text-[8px] font-semibold text-emerald-600 bg-emerald-100 px-1 py-px rounded-full">
                                          {t('session.status.inUse')}
                                        </span>
                                      )}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    {r.reachable && r.latencyMs != null ? (
                                      <>
                                        <div className="w-10 h-1 bg-cream-200 rounded-full overflow-hidden">
                                          <div
                                            className={`h-full rounded-full ${latencyBg(r.latencyMs)}`}
                                            style={{ width: `${Math.min(100, (r.latencyMs / 500) * 100)}%` }}
                                          />
                                        </div>
                                        <span className={`font-mono font-bold w-8 text-right ${latencyColor(r.latencyMs)}`}>
                                          {r.latencyMs}ms
                                        </span>
                                      </>
                                    ) : (
                                      <span className="text-charcoal-300 text-[9px]">{t('session.status.notAvailable')}</span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                    </div>
                  </div>
                );
              })()}

              {isStopped && (
                <span className="tag-badge whitespace-nowrap flex-shrink-0">{t('session.status.ended')}</span>
              )}

              {/* Connection error badge (only when idle/not active) */}
              {connectionState === 'error' && !isActive && !isStopped && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium
                                 bg-red-50 text-red-600 border border-red-200 whitespace-nowrap">
                  <span className="w-2 h-2 rounded-full bg-red-500" />
                  {t('session.status.connectionError')}
                </span>
              )}

              {serviceAvailable === false && isIdle && connectionState !== 'error' && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium
                                 bg-red-50 text-red-600 border border-red-200 whitespace-nowrap">
                  <span className="w-2 h-2 rounded-full bg-red-500" />
                  {t('session.status.serviceUnavailable')}
                </span>
              )}

              {shouldShowBackupBadge && (
                <span
                  title={backupTitle}
                  className={`flex items-center gap-2 px-2.5 py-1 rounded-lg text-xs font-medium border whitespace-nowrap ${backupBadge.containerClassName}`}
                >
                  <span className={`w-2 h-2 rounded-full ${backupBadge.dotClassName}`} />
                  <span>{backupBadge.label}</span>
                  <span className="font-mono opacity-75">{backupBadge.detail}</span>
                </span>
              )}

              <LiveShareBadge />
            </div>

            {/* ── Right: Action buttons + Mic + Language + Settings ── */}
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {/* Start / Pause / Resume button */}
              {isIdle && serviceAvailable !== false && (
                <ExpandableButton
                  icon={<Circle className="w-3.5 h-3.5 fill-current" />}
                  label={t('common.start')}
                  variant="primary"
                  onClick={() => { void handleStartRecording(); }}
                  title={t('session.actions.startTitle')}
                />
              )}
              {isStopped && !hasPendingSave && (
                <ExpandableButton
                  icon={<Play className="w-3.5 h-3.5 fill-current" />}
                  label={t('common.view')}
                  variant="primary"
                  onClick={() => router.push(`/session/${sessionId}/playback`)}
                  title={t('session.actions.viewTitle')}
                />
              )}
              {isRecording && (
                <ExpandableButton
                  icon={<Pause className="w-3.5 h-3.5" />}
                  label={t('common.pause')}
                  variant="primary"
                  onClick={pauseRecording}
                  title={t('session.actions.pauseTitle')}
                />
              )}
              {isPaused && !hasPendingSave && (
                <ExpandableButton
                  icon={<Play className="w-3.5 h-3.5 fill-current" />}
                  label={t('common.resume')}
                  variant="primary"
                  onClick={() => { void handleStartRecording(); }}
                  title={t('session.actions.resumeTitle')}
                />
              )}
              {isPaused && hasPendingSave && (
                <ExpandableButton
                  icon={<RefreshCw className="w-3.5 h-3.5" />}
                  label={t('session.actions.retrySave')}
                  variant="primary"
                  onClick={handleStopWithFinalization}
                  title={t('session.actions.retrySaveTitle')}
                />
              )}

              {/* Stop button */}
              <ExpandableButton
                icon={<Square className="w-3 h-3 fill-current" />}
                label={t('common.stop')}
                variant={isActive ? 'danger' : 'default'}
                disabled={!isActive}
                onClick={handleStopWithFinalization}
                title={t('session.actions.stopTitle')}
              />

              {/* Share button */}
              <SharePopover sessionId={sessionId} isActive={isActive} />

              {/* Export / Download button */}
              <ExpandableButton
                icon={<Download className="w-3.5 h-3.5" />}
                label={t('common.download')}
                disabled={isIdle}
                onClick={() => setExportOpen(true)}
                title={t('session.actions.exportTitle')}
              />

              {/* 画中画按钮 */}
              <ExpandableButton
                icon={<PictureInPicture2 className="w-3.5 h-3.5" />}
                label={pip.isOpen ? t('session.actions.closePip') : t('session.actions.pip')}
                variant={pip.isOpen ? 'active' : 'default'}
                onClick={pip.toggle}
                title={t('session.actions.pipTitle')}
              />

              {/* Divider */}
              <div className="w-px h-6 bg-cream-300 mx-0.5" />

              {/* Settings */}
              <button
                onClick={() => setSettingsOpen(true)}
                className="w-9 h-9 flex items-center justify-center rounded-lg
                           hover:bg-cream-100 text-charcoal-400 transition-colors"
              >
                <Settings className="w-4 h-4" />
              </button>
            </div>
          </div>
        </header>

        {/* ── Main content: Transcript + AI Panel ── */}
        <div className="flex-1 flex gap-4 p-4 min-h-0 overflow-hidden">
          <div className="flex-1 min-w-0">
            <TranscriptPanel />
          </div>
          <div className="w-[380px] flex-shrink-0">
            <AiPanel
              onManualSummary={triggerManual}
              onInjectKeywords={handleInjectKeywords}
            />
          </div>
        </div>
      </main>

      <SettingsDrawer isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} onSwitchMic={switchMicrophone} onSettingsApplied={rebuildSession} />
      <ExportModal
        isOpen={exportOpen}
        onClose={() => setExportOpen(false)}
        sessionTitle={sessionMetaReady ? sessionTitle : ''}
        sessionId={sessionId}
        sourceLang={sessionMetaReady ? sessionSourceLang : undefined}
        targetLang={sessionMetaReady ? sessionTargetLang : undefined}
        segments={segments}
        translations={translations}
        summaries={summaryBlocksToResponses(summaryBlocks)}
      />

      {/* v2.1: Finalization overlay */}
      <SessionFinalizingOverlay steps={finalizingSteps} visible={isFinalizing} />

      {/* 画中画翻译窗口 — Document PiP (Chrome) 或页内悬浮面板 (Safari/Firefox) */}
      {pip.isOpen && pip.mode === 'document-pip' && pip.pipWindow && (
        <PipPortal
          pipWindow={pip.pipWindow}
          pinned={pip.pinned}
          onTogglePin={() => pip.setPinned(!pip.pinned)}
          onClose={pip.close}
        />
      )}
      {pip.isOpen && pip.mode === 'video-pip' && (
        <VideoPipBridge updateData={pip.videoPipUpdate} />
      )}
      {pip.isOpen && pip.mode === 'inline' && (
        <InlinePipPanel
          pinned={pip.pinned}
          onTogglePin={() => pip.setPinned(!pip.pinned)}
          onClose={pip.close}
        />
      )}
    </div>
  );
}
