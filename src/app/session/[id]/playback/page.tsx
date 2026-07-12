'use client';

// v2.1 §C.4: Independent playback view for COMPLETED/ARCHIVED sessions
// Completely separate from the recording view — focused on review & audio playback

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import UserSettingsModal from '@/components/UserSettingsModal';
import ExportModal from '@/components/ExportModal';
import MobilePlaybackLayout from '@/components/mobile/MobilePlaybackLayout';
import PlaybackSharePopover from '@/components/session/PlaybackSharePopover';
import ChatTab from '@/components/session/ChatTab';
import ConfirmDialog from '@/components/ConfirmDialog';
import { toast } from '@/stores/toastStore';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useI18n } from '@/lib/i18n';
import { summaryBlocksToResponses } from '@/lib/summary';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAuthStore } from '@/stores/authStore';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { shouldPlaybackYieldToLiveStore } from '@/lib/session/recordingLifecycle';
import { useSummaryStore } from '@/stores/summaryStore';
import { useTranslationStore } from '@/stores/translationStore';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Download,
  Clock,
  Calendar,
  Globe,
  FileText,
  MessageSquare,
  Sparkles,
  ChevronLeft,
  Volume2,
  VolumeX,
  Volume1,
  ClipboardList,
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
import {
  triggerFullTranscribe,
  pollFullTranscribeStatus,
  isFullTranscribeInProgress,
  type FullTranscribeStatus,
} from '@/lib/transcribe/fullTranscribeClient';
import type { TranscriptSegment } from '@/types/transcript';
import type { SummaryBlock } from '@/types/summary';
import type { SessionReportData } from '@/types/report';

interface SessionData {
  id: string;
  title: string;
  titleEn?: string;
  createdAt: string;
  durationMs: number;
  sourceLang: string;
  targetLang: string;
  status: string;
  courseName?: string;
  audioSource?: string;
  sonioxRegion?: string;
  recordingPath?: string | null;
  fullTranscribeStatus?: string | null;
  fullTranscriptPath?: string | null;
  audioEnhanceStatus?: string | null;
  enhancedAudioPath?: string | null;
}

// 完整版补全转录的默认计费倍率（异步文件转录，admin 可在站点设置里调整）。
// 收费确认弹窗按此在前端预估「约 N 分钟」；服务端 finalize 时按站点实际倍率精确扣费，
// 额度不足由服务端 402 兜底 —— 故此处用「约」表述。
const FULL_TRANSCRIBE_MULTIPLIER = 0.8;

// 进行中状态 → i18n key 后缀（playback.fullTranscribe.status<Suffix>）。
function statusSuffix(status: FullTranscribeStatus | null): string {
  switch (status) {
    case 'transcoding':
      return 'Transcoding';
    case 'transcribing':
      return 'Transcribing';
    case 'finalizing':
      return 'Finalizing';
    case 'pending':
    default:
      return 'Pending';
  }
}

interface PlaybackAudioSegment {
  url: string;
  durationMs: number;
  startOffsetMs: number;
}

interface PlaybackClockState {
  segmentIndex: number;
  lastKnownSegmentTimeMs: number;
  lastKnownGlobalTimeMs: number;
  lastTickAtMs: number;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

type PlaybackTab = 'report' | 'summary' | 'chat' | 'info';

const WEBM_HEADER = [0x1a, 0x45, 0xdf, 0xa3] as const;

function hasWebmDocType(bytes: Uint8Array, start: number): boolean {
  const maxOffset = Math.min(bytes.length - 4, start + 128);
  for (let index = start; index <= maxOffset; index += 1) {
    if (
      bytes[index] === 0x77 &&
      bytes[index + 1] === 0x65 &&
      bytes[index + 2] === 0x62 &&
      bytes[index + 3] === 0x6d
    ) {
      return true;
    }
  }

  return false;
}

function splitConcatenatedWebmBuffer(
  buffer: ArrayBuffer,
  mimeType: string
): Blob[] {
  const bytes = new Uint8Array(buffer);
  const offsets: number[] = [];
  const normalizedMimeType = mimeType.toLowerCase().includes('webm')
    ? mimeType
    : 'audio/webm';

  for (let index = 0; index <= bytes.length - WEBM_HEADER.length; index += 1) {
    if (
      bytes[index] === WEBM_HEADER[0] &&
      bytes[index + 1] === WEBM_HEADER[1] &&
      bytes[index + 2] === WEBM_HEADER[2] &&
      bytes[index + 3] === WEBM_HEADER[3] &&
      hasWebmDocType(bytes, index)
    ) {
      offsets.push(index);
    }
  }

  if (offsets.length <= 1) {
    return [new Blob([buffer], { type: mimeType })];
  }

  const boundaries =
    offsets[0] === 0 ? offsets : [0, ...offsets.filter((offset) => offset > 0)];

  return boundaries.map((startOffset, index) => {
    const endOffset = boundaries[index + 1] ?? bytes.length;
    return new Blob([bytes.slice(startOffset, endOffset)], {
      type: normalizedMimeType,
    });
  });
}

function loadBlobDurationMs(url: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    let settled = false;

    const finish = (durationMs: number) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      cleanup();
      resolve(durationMs);
    };

    const reportDuration = () => {
      const durationMs =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000
          : 0;
      if (durationMs > 0) {
        finish(durationMs);
      }
    };

    const cleanup = () => {
      audio.onloadedmetadata = null;
      audio.ondurationchange = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
    };
    // 大文件可能需要更长时间探测时长，从 2s 提升到 8s
    const timeoutId = window.setTimeout(() => {
      const durationMs =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000
          : 0;
      finish(durationMs);
    }, 8000);

    audio.onloadedmetadata = reportDuration;
    audio.ondurationchange = reportDuration;
    audio.onerror = () => {
      finish(0);
    };

    audio.preload = 'auto';
    audio.src = url;
  });
}

export default function PlaybackPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = params.id as string;
  const shareToken = searchParams.get('token');
  const isShareMode = Boolean(shareToken);
  const { restoreSession } = useAuth();
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const isMobile = useIsMobile();
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const addFinalSegment = useTranscriptStore((s) => s.addFinalSegment);
  const clearTranscript = useTranscriptStore((s) => s.clearAll);
  const addSummaryBlock = useSummaryStore((s) => s.addBlock);
  const clearSummaries = useSummaryStore((s) => s.clearAll);
  const setTranslation = useTranslationStore((s) => s.setTranslation);
  const translations = useTranslationStore((s) => s.translations);
  const clearTranslations = useTranslationStore((s) => s.clearAll);
  const restoreAttemptedRef = useRef(false);
  const restoreInFlightRef = useRef(false);

  const [session, setSession] = useState<SessionData | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [summaries, setSummaries] = useState<SummaryBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PlaybackTab>('report');
  const [exportOpen, setExportOpen] = useState(false);
  const [reportData, setReportData] = useState<SessionReportData | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [regeneratingReport, setRegeneratingReport] = useState(false);
  const [regeneratingTitle, setRegeneratingTitle] = useState(false);
  const [regenerateConfirmOpen, setRegenerateConfirmOpen] = useState(false);

  // 完整版补全转录（阶段B）：触发 → 收费确认 → 进度轮询 → 「实时/完整版」切换查看
  const [fullStatus, setFullStatus] = useState<FullTranscribeStatus | null>(null);
  const [fullConfirmOpen, setFullConfirmOpen] = useState(false);
  const [fullTriggering, setFullTriggering] = useState(false);
  const [transcriptView, setTranscriptView] = useState<'live' | 'full'>('live');
  const [fullSegments, setFullSegments] = useState<TranscriptSegment[]>([]);
  const [fullLoaded, setFullLoaded] = useState(false);
  const fullPollAbortRef = useRef<AbortController | null>(null);
  const fullInitializedRef = useRef(false);

  // 音频增强（响度归一化+降噪，外部 worker）：触发 → 轮询 → 「原声/增强」音源切换
  const [enhanceStatus, setEnhanceStatus] = useState<string | null>(null);
  const [enhanceReady, setEnhanceReady] = useState(false);
  const [enhanceAvailable, setEnhanceAvailable] = useState(false);
  const [enhanceTriggering, setEnhanceTriggering] = useState(false);
  // null = 尚未决定（等 session 加载完，增强就绪则默认增强），音频加载 effect 据此等待
  const [audioVariant, setAudioVariant] = useState<'original' | 'enhanced' | null>(null);
  const enhancePollAbortRef = useRef<AbortController | null>(null);
  const enhanceInitializedRef = useRef(false);
  // 切换音源时带着当前播放进度恢复（音频重新加载后 seek 回原位置）
  const pendingVariantResumeMsRef = useRef<number | null>(null);

  // Audio player state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [audioSegments, setAudioSegments] = useState<PlaybackAudioSegment[]>([]);
  const [activeAudioIndex, setActiveAudioIndex] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioSegmentsRef = useRef<PlaybackAudioSegment[]>([]);
  /** 缓存完整音频 blob，供导出复用，避免重复下载 */
  const recordingBlobRef = useRef<Blob | null>(null);
  const activeAudioIndexRef = useRef(0);
  const isPlayingRef = useRef(false);
  // currentTimeMs 的 ref 镜像：切音源等低频回调里读进度，避免把秒级变化的 state 挂进依赖
  const currentTimeMsRef = useRef(0);
  const playbackClockRef = useRef<number | null>(null);
  const playbackClockStateRef = useRef<PlaybackClockState | null>(null);
  const shouldResumePlaybackRef = useRef(false);
  const pendingSeekMsRef = useRef<number | null>(null);
  const sessionDurationMsRef = useRef<number>(0);

  // Auth guard — 分享模式下跳过认证
  useEffect(() => {
    if (isShareMode) return;
    if (user && token) return;
    // restoreSession 正在进行中：StrictMode 双调用或快速重渲染时，不能误跳 /login
    if (restoreInFlightRef.current) return;
    if (!restoreAttemptedRef.current) {
      restoreAttemptedRef.current = true;
      restoreInFlightRef.current = true;
      restoreSession().then((ok) => {
        restoreInFlightRef.current = false;
        if (!ok) {
          const { user: u, token: t } = useAuthStore.getState();
          if (!u || !t) {
            router.replace('/login');
          }
        }
      });
      return;
    }
    const { user: u, token: t } = useAuthStore.getState();
    if (!u || !t) {
      router.replace('/login');
    }
  }, [user, token, router, restoreSession, isShareMode]);

  // Fetch session data + transcript（支持认证模式和分享模式）
  useEffect(() => {
    if (!isShareMode && !token) return;
    setLoading(true);

    const authHeaders: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    // 根据模式选择 API
    const sessionUrl = isShareMode
      ? `/api/share/view/${encodeURIComponent(shareToken!)}`
      : `/api/sessions/${sessionId}`;
    const transcriptUrl = isShareMode
      ? `/api/share/view/${encodeURIComponent(shareToken!)}/transcript`
      : `/api/sessions/${sessionId}/transcript`;
    const reportUrl = isShareMode
      ? `/api/share/view/${encodeURIComponent(shareToken!)}/report`
      : `/api/llm/report?sessionId=${sessionId}`;

    fetch(sessionUrl, isShareMode ? undefined : { headers: authHeaders })
      .then((r) => r.json())
      .then(async (data) => {
        if (data.error) {
          setError(data.error);
          return;
        }

        // 分享模式：从 data.session 取出会话信息
        const sessionData = isShareMode ? data.session : data;
        if (!sessionData) {
          setError(t('playback.sessionNotFound'));
          return;
        }

        // If session is still recording, redirect to live page (仅认证模式)
        if (!isShareMode && ['CREATED', 'RECORDING', 'PAUSED', 'FINALIZING'].includes(sessionData.status)) {
          router.replace(`/session/${sessionId}`);
          return;
        }
        setSession(sessionData);

        // Load transcript and summary data
        try {
          const tRes = await fetch(transcriptUrl, isShareMode ? undefined : { headers: authHeaders });
          if (tRes.ok) {
            const tData = await tRes.json();
            if (Array.isArray(tData.segments)) {
              const translations: Record<string, string> = tData.translations || {};
              setSegments(
                tData.segments.map((seg: TranscriptSegment) => ({
                  ...seg,
                  translatedText: seg.translatedText || translations[seg.id] || undefined,
                }))
              );
            }
            if (Array.isArray(tData.summaries)) {
              setSummaries(tData.summaries);
            }
          }
        } catch {
          // transcript load failed — non-critical
        }

        // 加载会话报告
        try {
          setReportLoading(true);
          const rRes = await fetch(reportUrl, isShareMode ? undefined : { headers: authHeaders });
          if (rRes.ok) {
            const rData = await rRes.json();
            if (rData.report) {
              setReportData(rData.report);
            }
          }
        } catch {
          // report load failed — non-critical
        } finally {
          setReportLoading(false);
        }
      })
      .catch(() => setError(t('playback.loadFailed')))
      .finally(() => setLoading(false));
  }, [sessionId, token, router, t, isShareMode, shareToken]);

  // 加载音频（认证模式用 auth header，分享模式用 share API），必要时拆成多个连续 WebM 段
  useEffect(() => {
    if (!isShareMode && (!token || !sessionId)) return;
    if (isShareMode && !shareToken) return;
    // 音源未决定（等 session 加载判断增强版是否就绪）时先不加载，避免白下载一遍原始音频
    if (audioVariant === null) return;
    let disposed = false;
    const createdUrls: string[] = [];
    const abortController = new AbortController();

    const audioUrl = isShareMode
      ? `/api/share/view/${encodeURIComponent(shareToken!)}/audio`
      : `/api/sessions/${sessionId}/audio${
          audioVariant === 'enhanced' ? '?variant=enhanced' : ''
        }`;

    fetch(audioUrl, {
      ...(token && !isShareMode ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      signal: abortController.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('Audio load failed');
        const mimeType = res.headers.get('content-type') || 'audio/webm';
        const buffer = await res.arrayBuffer();
        // 缓存完整音频 blob，供导出时复用
        recordingBlobRef.current = new Blob([buffer], { type: mimeType });
        return { mimeType, buffer };
      })
      .then(async ({ mimeType, buffer }) => {
        if (disposed) return;

        const blobs = splitConcatenatedWebmBuffer(buffer, mimeType);
        const segmentsWithUrls = blobs.map((blob) => {
          const url = URL.createObjectURL(blob);
          createdUrls.push(url);
          return { blob, url };
        });

        const durations = await Promise.all(
          segmentsWithUrls.map(({ url }) => loadBlobDurationMs(url))
        );

        if (disposed) return;

        // 降级处理：如果有段的时长检测失败 (=0)，用字节比例 + session.durationMs 估算
        const totalBytes = blobs.reduce((sum, b) => sum + b.size, 0);
        const detectedTotalMs = durations.reduce((sum, d) => sum + d, 0);
        const fallbackTotalMs = sessionDurationMsRef.current;
        const hasZeroDuration = durations.some((d) => d <= 0);

        const resolvedDurations = durations.map((detected, idx) => {
          if (detected > 0) return detected;
          // 用字节比例 × 已知总时长来估算
          const referenceTotalMs =
            detectedTotalMs > 0
              ? detectedTotalMs
              : fallbackTotalMs > 0
                ? fallbackTotalMs
                : 0;
          if (referenceTotalMs <= 0 || totalBytes <= 0) return detected;
          const byteProportion = blobs[idx].size / totalBytes;
          return Math.max(1, Math.round(byteProportion * referenceTotalMs));
        });

        // 如果所有段的 detected duration 之和远超 session.durationMs，
        // 说明 fixWebmDuration 写入了不正确的总时长；改用字节比例重新分配
        if (
          !hasZeroDuration &&
          blobs.length > 1 &&
          fallbackTotalMs > 0 &&
          detectedTotalMs > fallbackTotalMs * 1.5
        ) {
          for (let i = 0; i < resolvedDurations.length; i++) {
            const byteProportion = blobs[i].size / totalBytes;
            resolvedDurations[i] = Math.max(
              1,
              Math.round(byteProportion * fallbackTotalMs)
            );
          }
        }

        let nextOffsetMs = 0;
        const nextSegments = segmentsWithUrls.map(({ url }, index) => {
          const segment: PlaybackAudioSegment = {
            url,
            durationMs: resolvedDurations[index],
            startOffsetMs: nextOffsetMs,
          };
          nextOffsetMs += resolvedDurations[index];
          return segment;
        });

        setAudioSegments(nextSegments);

        // 切换音源：恢复切换前的播放进度（找到所属段 + 段内偏移，交给 onLoadedMetadata 消费）
        const resumeMs = pendingVariantResumeMsRef.current;
        pendingVariantResumeMsRef.current = null;
        if (resumeMs !== null && resumeMs > 0 && nextSegments.length > 0) {
          const idx = nextSegments.findIndex(
            (seg) => resumeMs < seg.startOffsetMs + seg.durationMs
          );
          const target = idx >= 0 ? idx : nextSegments.length - 1;
          setActiveAudioIndex(target);
          setCurrentTimeMs(resumeMs);
          pendingSeekMsRef.current = Math.max(
            0,
            resumeMs - nextSegments[target].startOffsetMs
          );
        } else {
          setActiveAudioIndex(0);
          setCurrentTimeMs(0);
        }
        setIsPlaying(false);
      })
      .catch((err) => {
        console.error('Failed to load audio:', err);
      });

    return () => {
      disposed = true;
      abortController.abort();
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
      recordingBlobRef.current = null;
      setAudioSegments([]);
      setActiveAudioIndex(0);
    };
  }, [token, sessionId, isShareMode, shareToken, audioVariant]);

  // Sync to stores (for ChatTab / ExportModal)
  useEffect(() => {
    // 活跃录音上下文（recording/paused/finalizing）时让位：绝不清空、也绝不把回放页的历史
    // segments 灌进全局实时 store，否则会抹掉/污染正在进行的录音（含刷新恢复所依赖的
    // sessionStorage 快照，及尚未上传的最后一片音频）——审计 P1-8。按 sessionId 隔离。
    if (
      shouldPlaybackYieldToLiveStore(
        useTranscriptStore.getState().activeSessionId,
        sessionId,
        useTranscriptStore.getState().recordingState
      )
    ) {
      return;
    }

    clearTranscript();
    clearSummaries();
    clearTranslations();

    segments.forEach((segment) => {
      addFinalSegment(segment);
      if (segment.translatedText) {
        setTranslation(segment.id, segment.translatedText);
      }
    });
    summaries.forEach((summary) => addSummaryBlock(summary));

    return () => {
      if (
        shouldPlaybackYieldToLiveStore(
          useTranscriptStore.getState().activeSessionId,
          sessionId,
          useTranscriptStore.getState().recordingState
        )
      ) {
        return;
      }
      clearTranscript();
      clearSummaries();
      clearTranslations();
    };
  }, [
    sessionId,
    segments,
    summaries,
    addFinalSegment,
    clearTranscript,
    addSummaryBlock,
    clearSummaries,
    setTranslation,
    clearTranslations,
  ]);

  const activeAudioSegment = audioSegments[activeAudioIndex] ?? null;

  useEffect(() => {
    sessionDurationMsRef.current = session?.durationMs ?? 0;
  }, [session?.durationMs]);

  useEffect(() => {
    audioSegmentsRef.current = audioSegments;
  }, [audioSegments]);

  useEffect(() => {
    activeAudioIndexRef.current = activeAudioIndex;
  }, [activeAudioIndex]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    currentTimeMsRef.current = currentTimeMs;
  }, [currentTimeMs]);

  // 从 localStorage 恢复音量（仅初始化时执行一次，先于持久化）
  const volumeRestoredRef = useRef(false);
  if (!volumeRestoredRef.current && typeof window !== 'undefined') {
    volumeRestoredRef.current = true;
    try {
      const savedVol = window.localStorage.getItem('playback.volume');
      const savedMuted = window.localStorage.getItem('playback.muted');
      if (savedVol !== null) {
        const v = parseFloat(savedVol);
        if (!Number.isNaN(v)) {
          const clamped = Math.max(0, Math.min(1, v));
          if (clamped !== volume) setVolume(clamped);
        }
      }
      if (savedMuted !== null) {
        const m = savedMuted === 'true';
        if (m !== muted) setMuted(m);
      }
    } catch {
      /* localStorage may be unavailable */
    }
  }

  // 同步音量到 audio 元素 + 持久化
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.volume = volume;
      audio.muted = muted;
    }
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem('playback.volume', String(volume));
        window.localStorage.setItem('playback.muted', String(muted));
      } catch {
        /* localStorage may be unavailable */
      }
    }
  }, [volume, muted, activeAudioIndex]);

  const getTranscriptTimelineDurationMs = useCallback(() => {
    return segments.reduce((maxDuration, segment) => {
      const segmentEndMs =
        typeof segment.globalEndMs === 'number'
          ? segment.globalEndMs
          : segment.endMs;
      return Math.max(maxDuration, segmentEndMs);
    }, 0);
  }, [segments]);

  const getExpectedTimelineDurationMs = useCallback(() => {
    const measuredAudioDurationMs = audioSegmentsRef.current.reduce(
      (maxDuration, segment) => {
        return Math.max(maxDuration, segment.startOffsetMs + segment.durationMs);
      },
      0
    );

    return Math.max(
      measuredAudioDurationMs,
      session?.durationMs ?? 0,
      getTranscriptTimelineDurationMs()
    );
  }, [getTranscriptTimelineDurationMs, session?.durationMs]);

  const primePlaybackClockState = useCallback(
    (segmentIndex: number, segmentTimeMs: number) => {
      const segmentStartMs =
        audioSegmentsRef.current[segmentIndex]?.startOffsetMs ?? 0;

      playbackClockStateRef.current = {
        segmentIndex,
        lastKnownSegmentTimeMs: Math.max(0, segmentTimeMs),
        lastKnownGlobalTimeMs: segmentStartMs + Math.max(0, segmentTimeMs),
        lastTickAtMs: performance.now(),
      };
    },
    []
  );

  const getResolvedSegmentDurationMs = useCallback(
    (segmentIndex: number) => {
      const segment = audioSegmentsRef.current[segmentIndex];
      if (!segment) {
        return 0;
      }

      if (segment.durationMs > 0) {
        return segment.durationMs;
      }

      const nextSegment = audioSegmentsRef.current[segmentIndex + 1];
      if (nextSegment) {
        return Math.max(
          0,
          nextSegment.startOffsetMs - segment.startOffsetMs
        );
      }

      return Math.max(
        0,
        getExpectedTimelineDurationMs() - segment.startOffsetMs
      );
    },
    [getExpectedTimelineDurationMs]
  );

  const seekToMs = useCallback(
    (targetMs: number, options?: { resumePlayback?: boolean }) => {
      if (audioSegments.length === 0) {
        return;
      }

      const totalDurationMs = getExpectedTimelineDurationMs();

      const clampedTargetMs = Math.max(
        0,
        Math.min(targetMs, totalDurationMs || targetMs)
      );

      const nextIndex = audioSegments.findIndex((segment, index) => {
        const segmentEndMs =
          segment.startOffsetMs + getResolvedSegmentDurationMs(index);
        return clampedTargetMs < segmentEndMs;
      });

      const resolvedIndex = nextIndex >= 0 ? nextIndex : audioSegments.length - 1;
      const nextSegment = audioSegments[resolvedIndex];
      const localTimeMs = Math.max(
        0,
        clampedTargetMs - nextSegment.startOffsetMs
      );

      shouldResumePlaybackRef.current =
        options?.resumePlayback ?? isPlaying;
      primePlaybackClockState(resolvedIndex, localTimeMs);

      if (resolvedIndex === activeAudioIndex && audioRef.current) {
        audioRef.current.currentTime = localTimeMs / 1000;
        setCurrentTimeMs(clampedTargetMs);
        return;
      }

      pendingSeekMsRef.current = localTimeMs;
      setActiveAudioIndex(resolvedIndex);
      setCurrentTimeMs(clampedTargetMs);
    },
    [
      activeAudioIndex,
      audioSegments,
      getExpectedTimelineDurationMs,
      getResolvedSegmentDurationMs,
      isPlaying,
      primePlaybackClockState,
    ]
  );

  // Click transcript segment → jump audio to that time
  const handleSegmentClick = useCallback(
    (startMs: number) => {
      seekToMs(startMs);
    },
    [seekToMs]
  );

  const syncPlaybackState = useCallback((options?: {
    allowWallClockFallback?: boolean;
    resetClock?: boolean;
  }) => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const segmentIndex = activeAudioIndexRef.current;
    const segment = audioSegmentsRef.current[segmentIndex] ?? null;
    if (!segment) {
      return;
    }

    const now = performance.now();
    const rawSegmentTimeMs = Number.isFinite(audio.currentTime)
      ? Math.max(0, audio.currentTime * 1000)
      : 0;
    const expectedDurationMs = getExpectedTimelineDurationMs();
    const resolvedSegmentDurationMs = getResolvedSegmentDurationMs(segmentIndex);
    const segmentEndMs =
      resolvedSegmentDurationMs > 0
        ? segment.startOffsetMs + resolvedSegmentDurationMs
        : expectedDurationMs;

    let clockState = playbackClockStateRef.current;
    if (
      options?.resetClock ||
      !clockState ||
      clockState.segmentIndex !== segmentIndex
    ) {
      clockState = {
        segmentIndex,
        lastKnownSegmentTimeMs: rawSegmentTimeMs,
        lastKnownGlobalTimeMs: segment.startOffsetMs + rawSegmentTimeMs,
        lastTickAtMs: now,
      };
      playbackClockStateRef.current = clockState;
    }

    const mediaAdvanced =
      rawSegmentTimeMs > clockState.lastKnownSegmentTimeMs + 40;

    if (
      audio.paused ||
      audio.ended ||
      mediaAdvanced ||
      rawSegmentTimeMs > 0
    ) {
      const nextGlobalTimeMs = Math.min(
        segmentEndMs || Number.POSITIVE_INFINITY,
        segment.startOffsetMs + rawSegmentTimeMs
      );
      clockState.lastKnownSegmentTimeMs = rawSegmentTimeMs;
      clockState.lastKnownGlobalTimeMs = nextGlobalTimeMs;
      clockState.lastTickAtMs = now;
      setCurrentTimeMs(nextGlobalTimeMs);
      return;
    }

    if (!options?.allowWallClockFallback) {
      setCurrentTimeMs(clockState.lastKnownGlobalTimeMs);
      return;
    }

    const elapsedWallMs = Math.max(0, now - clockState.lastTickAtMs);
    if (elapsedWallMs < 250) {
      setCurrentTimeMs(clockState.lastKnownGlobalTimeMs);
      return;
    }

    const nextGlobalTimeMs = Math.min(
      segmentEndMs,
      clockState.lastKnownGlobalTimeMs + elapsedWallMs * audio.playbackRate
    );
    const nextSegmentTimeMs = Math.max(
      0,
      nextGlobalTimeMs - segment.startOffsetMs
    );

    clockState.lastKnownSegmentTimeMs = Math.max(
      clockState.lastKnownSegmentTimeMs,
      nextSegmentTimeMs
    );
    clockState.lastKnownGlobalTimeMs = nextGlobalTimeMs;
    clockState.lastTickAtMs = now;
    setCurrentTimeMs(nextGlobalTimeMs);
  }, [getExpectedTimelineDurationMs, getResolvedSegmentDurationMs]);

  const stopPlaybackClock = useCallback(() => {
    if (playbackClockRef.current !== null) {
      window.clearInterval(playbackClockRef.current);
      playbackClockRef.current = null;
    }
  }, []);

  const startPlaybackClock = useCallback(() => {
    stopPlaybackClock();
    syncPlaybackState();

    playbackClockRef.current = window.setInterval(() => {
      const audio = audioRef.current;
      if (!audio) {
        stopPlaybackClock();
        return;
      }

      syncPlaybackState({ allowWallClockFallback: true });
      if (audio.paused || audio.ended) {
        stopPlaybackClock();
      }
    }, 100);
  }, [stopPlaybackClock, syncPlaybackState]);

  useEffect(() => {
    return () => {
      stopPlaybackClock();
    };
  }, [stopPlaybackClock]);

  useEffect(() => {
    stopPlaybackClock();
    setIsPlaying(false);
    isPlayingRef.current = false;
    setCurrentTimeMs(0);
    playbackClockStateRef.current = null;
    shouldResumePlaybackRef.current = false;
    pendingSeekMsRef.current = null;
  }, [audioSegments, stopPlaybackClock]);

  const togglePlayback = useCallback(() => {
    if (!audioRef.current || !activeAudioSegment) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      void audioRef.current.play();
    }
  }, [activeAudioSegment, isPlaying]);

  const cycleSpeed = useCallback(() => {
    const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
    const idx = speeds.indexOf(playbackRate);
    const next = speeds[(idx + 1) % speeds.length];
    setPlaybackRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }, [playbackRate]);

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }

    audioRef.current.playbackRate = playbackRate;
  }, [activeAudioSegment, playbackRate]);

  // 「实时/完整版」切换：仅影响可见转录列表 + 高亮 + 计数；ChatTab/导出仍绑定实时 segments。
  // 完整版 segments 与实时同一音频时间轴，故点击跳转 seek 逻辑无需改动。
  const displaySegments = transcriptView === 'full' ? fullSegments : segments;
  const hasFullTranscript = fullStatus === 'completed';
  const fullInProgress = isFullTranscribeInProgress(fullStatus);
  // 完整版转录入口门控（desktop header 按钮同口径）：非分享 + 会话已完成/归档 + 有录音。
  const canGenerateFull =
    !isShareMode &&
    !!session &&
    (session.status === 'COMPLETED' || session.status === 'ARCHIVED') &&
    Boolean(session.recordingPath);
  // 生成按钮文案：进行中态文案 / 已就绪→重新生成 / 未生成→生成。
  const fullButtonLabel = fullInProgress
    ? t(`playback.fullTranscribe.status${statusSuffix(fullStatus)}`)
    : hasFullTranscript
      ? t('playback.fullTranscribe.regenerate')
      : t('playback.fullTranscribe.button');

  // 音频增强：进行中（排队/处理中）与入口门控（与完整版转录同口径）
  const enhanceInProgress =
    enhanceStatus === 'pending' || enhanceStatus === 'processing';
  const canEnhanceAudio =
    !isShareMode &&
    !!session &&
    (session.status === 'COMPLETED' || session.status === 'ARCHIVED') &&
    Boolean(session.recordingPath);

  // Determine which segment is "active" based on current playback time
  const activeSegmentId = displaySegments.find(
    (s) => s.globalStartMs <= currentTimeMs && s.globalEndMs >= currentTimeMs
  )?.id;

  // 播放时自动滚动到当前 segment
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const activeSegmentRef = useRef<HTMLDivElement>(null);
  const [transcriptAutoScroll, setTranscriptAutoScroll] = useState(true);
  const userScrolledRef = useRef(false);
  const isAutoScrollingRef = useRef(false);

  const handleTranscriptScroll = useCallback(() => {
    if (isAutoScrollingRef.current) return;
    const el = transcriptScrollRef.current;
    if (!el) return;
    const isNearActive = activeSegmentRef.current
      ? (() => {
          const rect = activeSegmentRef.current.getBoundingClientRect();
          const containerRect = el.getBoundingClientRect();
          return rect.top >= containerRect.top - 50 && rect.bottom <= containerRect.bottom + 50;
        })()
      : true;
    if (!isNearActive && !userScrolledRef.current) {
      userScrolledRef.current = true;
      setTranscriptAutoScroll(false);
    }
  }, []);

  useEffect(() => {
    if (!transcriptAutoScroll || !activeSegmentRef.current || !transcriptScrollRef.current) return;
    isAutoScrollingRef.current = true;
    activeSegmentRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timer = setTimeout(() => { isAutoScrollingRef.current = false; }, 500);
    return () => clearTimeout(timer);
  }, [activeSegmentId, transcriptAutoScroll]);

  // 用户点击 segment 时恢复自动滚动
  const handleSegmentClickWithScroll = useCallback((startMs: number) => {
    handleSegmentClick(startMs);
    setTranscriptAutoScroll(true);
    userScrolledRef.current = false;
  }, [handleSegmentClick]);

  // 导出录音回调：复用已加载的 blob，避免重复下载
  const handleRegenerateTitle = useCallback(() => {
    if (!sessionId || !token || regeneratingTitle) return;
    setRegenerateConfirmOpen(true);
  }, [sessionId, token, regeneratingTitle]);

  const handleRegenerateTitleConfirm = useCallback(async () => {
    if (!sessionId || !token) return;
    setRegenerateConfirmOpen(false);
    setRegeneratingTitle(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/regenerate-title`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(t('playback.regenerateTitleFail'), data.error || undefined);
        return;
      }
      const data = await res.json();
      if (data.success && session) {
        setSession({ ...session, title: data.title, titleEn: data.titleEn });
      }
    } catch {
      toast.error(t('playback.regenerateTitleFail'));
    } finally {
      setRegeneratingTitle(false);
    }
  }, [sessionId, token, session, t]);

  // 报告生成失败 / 缺失时的重新生成入口（POST 生成 + 重新拉取 GET）。分享模式不提供。
  const handleRegenerateReport = useCallback(async () => {
    if (!sessionId || !token || regeneratingReport) return;
    setRegeneratingReport(true);
    setReportLoading(true);
    try {
      const res = await fetch('/api/llm/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(t('playback.reportRegenFailed'), body.error || undefined);
        return;
      }
      // 重新拉取已持久化的完整报告对象（与首屏加载同口径）。
      const rRes = await fetch(`/api/llm/report?sessionId=${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (rRes.ok) {
        const rData = await rRes.json();
        setReportData(rData.report ?? null);
      }
      toast.success(t('playback.reportRegenDone'));
    } catch {
      toast.error(t('playback.reportRegenFailed'));
    } finally {
      setRegeneratingReport(false);
      setReportLoading(false);
    }
  }, [sessionId, token, regeneratingReport, t]);

  const fetchRecordingForExport = useCallback(async (): Promise<Blob | null> => {
    if (recordingBlobRef.current) {
      return recordingBlobRef.current;
    }
    // 回退：blob 尚未加载或已被清理时，重新 fetch
    // 分享模式使用 share audio API
    if (isShareMode && shareToken) {
      try {
        const res = await fetch(`/api/share/view/${encodeURIComponent(shareToken)}/audio`);
        if (!res.ok) return null;
        const blob = await res.blob();
        recordingBlobRef.current = blob;
        return blob;
      } catch {
        return null;
      }
    }
    if (!sessionId || !token) return null;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/audio`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      recordingBlobRef.current = blob;
      return blob;
    } catch {
      return null;
    }
  }, [sessionId, token, isShareMode, shareToken]);

  // ─── 完整版补全转录（阶段B） ───

  // 收费预估：ceil(可计费分钟 × 倍率)，与服务端 402 判定同口径（用默认倍率，故弹窗表述「约」）。
  const fullEstimateMinutes = useMemo(() => {
    const billableMinutes = Math.ceil(Math.max(0, session?.durationMs ?? 0) / 60_000);
    return Math.max(0, Math.ceil(billableMinutes * FULL_TRANSCRIBE_MULTIPLIER));
  }, [session?.durationMs]);

  // 读取完整版转录 bundle（切到「完整版」视图 / 收尾完成时懒加载一次）。
  const loadFullTranscriptData = useCallback(async () => {
    if (!token || !sessionId) return;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/full-transcript`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.segments)) {
        const tr: Record<string, string> = data.translations || {};
        setFullSegments(
          data.segments.map((seg: TranscriptSegment) => ({
            ...seg,
            translatedText: seg.translatedText || tr[seg.id] || undefined,
          }))
        );
        setFullLoaded(true);
      }
    } catch {
      // 非关键：加载失败保持切换按钮，用户可重试
    }
  }, [token, sessionId]);

  // 接管一次状态轮询（触发后 / 刷新回到进行中态时）。收尾完成即拉取完整版并提示。
  const startFullPoll = useCallback(() => {
    if (!token || !sessionId) return;
    fullPollAbortRef.current?.abort();
    const ctrl = new AbortController();
    fullPollAbortRef.current = ctrl;
    void pollFullTranscribeStatus(sessionId, token, {
      signal: ctrl.signal,
      onStatusChange: (s) => setFullStatus(s),
    }).then((result) => {
      if (ctrl.signal.aborted) return;
      if (result.finalStatus === 'completed') {
        setFullStatus('completed');
        void loadFullTranscriptData();
        toast.success(t('playback.fullTranscribe.doneToast'));
      } else if (result.finalStatus === 'failed') {
        setFullStatus('failed');
        toast.error(t('playback.fullTranscribe.failToast'), result.error || undefined);
      }
    });
  }, [token, sessionId, loadFullTranscriptData, t]);

  const handleGenerateFull = useCallback(() => {
    if (!sessionId || !token) return;
    setFullConfirmOpen(true);
  }, [sessionId, token]);

  const handleGenerateFullConfirm = useCallback(async () => {
    if (!sessionId || !token) return;
    setFullTriggering(true);
    try {
      const result = await triggerFullTranscribe(sessionId, token);
      if (result.httpStatus === 402) {
        toast.error(
          t('playback.fullTranscribe.insufficientQuota', {
            minutes: String(result.estimatedMinutes ?? fullEstimateMinutes),
          })
        );
        setFullConfirmOpen(false);
        return;
      }
      if (!result.ok) {
        // 409（会话未完成/无录音）等
        toast.error(t('playback.fullTranscribe.triggerFail'), result.error || undefined);
        setFullConfirmOpen(false);
        return;
      }
      // 200：{status:'pending', estimatedMinutes} 或 {alreadyRunning:true, status}
      // 重新生成时重置已加载的旧完整版，回到实时视图，等新一轮收尾后再懒加载。
      setFullLoaded(false);
      setFullSegments([]);
      setTranscriptView('live');
      setFullStatus(result.status ?? 'pending');
      setFullConfirmOpen(false);
      startFullPoll();
    } catch {
      toast.error(t('playback.fullTranscribe.triggerFail'));
      setFullConfirmOpen(false);
    } finally {
      setFullTriggering(false);
    }
  }, [sessionId, token, fullEstimateMinutes, startFullPoll, t]);

  // 初始化：会话加载后读初始 fullTranscribeStatus；若进行中则接管轮询（刷新恢复）。
  useEffect(() => {
    if (isShareMode || !session || fullInitializedRef.current) return;
    fullInitializedRef.current = true;
    const initial = (session.fullTranscribeStatus as FullTranscribeStatus | null) ?? null;
    setFullStatus(initial);
    if (isFullTranscribeInProgress(initial)) {
      startFullPoll();
    }
  }, [session, isShareMode, startFullPoll]);

  // 卸载时中止在途轮询，避免泄漏 / setState-after-unmount。
  useEffect(() => {
    return () => {
      fullPollAbortRef.current?.abort();
    };
  }, []);

  const handleSwitchTranscriptView = useCallback(
    (view: 'live' | 'full') => {
      setTranscriptView(view);
      if (view === 'full' && !fullLoaded) {
        void loadFullTranscriptData();
      }
    },
    [fullLoaded, loadFullTranscriptData]
  );

  // ── 音频增强：状态轮询 / 手动触发 / 音源切换 ──

  // 轮询 enhance-status（5s 间隔；该端点会顺便驱动服务端状态机推进）。
  // 终态即停：completed 提示可切换增强版，failed 提示错误（按钮变重试）。
  const startEnhancePoll = useCallback(() => {
    if (!token || !sessionId) return;
    enhancePollAbortRef.current?.abort();
    const ctrl = new AbortController();
    enhancePollAbortRef.current = ctrl;
    const tick = async () => {
      if (ctrl.signal.aborted) return;
      try {
        const res = await fetch(`/api/sessions/${sessionId}/enhance-status`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        });
        if (res.ok) {
          const data = await res.json();
          if (ctrl.signal.aborted) return;
          setEnhanceStatus(data.status ?? null);
          setEnhanceAvailable(Boolean(data.available));
          setEnhanceReady(Boolean(data.enhancedAudioReady));
          if (data.status === 'completed') {
            // 不自动切换音源（可能正在听原声），toast 引导用户手动切
            toast.success(t('playback.audioEnhance.doneToast'));
            return;
          }
          if (data.status === 'failed') {
            toast.error(
              t('playback.audioEnhance.failToast'),
              data.error || undefined
            );
            return;
          }
        }
      } catch {
        // 网络抖动：继续下一轮
      }
      if (!ctrl.signal.aborted) {
        setTimeout(() => void tick(), 5000);
      }
    };
    void tick();
  }, [token, sessionId, t]);

  // 手动触发增强（免费路径无确认弹窗；已在途时服务端幂等返回现状）
  const handleTriggerEnhance = useCallback(async () => {
    if (!sessionId || !token) return;
    setEnhanceTriggering(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/enhance-audio`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(
          t('playback.audioEnhance.triggerFail'),
          data?.error || undefined
        );
        return;
      }
      setEnhanceStatus(data?.status ?? 'pending');
      startEnhancePoll();
    } catch {
      toast.error(t('playback.audioEnhance.triggerFail'));
    } finally {
      setEnhanceTriggering(false);
    }
  }, [sessionId, token, startEnhancePoll, t]);

  // 切换「原声 / 增强」音源：带着当前进度重新加载（audioVariant 变化触发音频 effect）
  const handleSwitchAudioVariant = useCallback(
    (variant: 'original' | 'enhanced') => {
      setAudioVariant((prev) => {
        if (prev === variant) return prev;
        pendingVariantResumeMsRef.current = currentTimeMsRef.current;
        return variant;
      });
    },
    []
  );

  // 初始化：会话加载后决定初始音源（增强版就绪则默认增强），进行中则接管轮询（刷新恢复）。
  // 分享模式不查状态：分享音频端点在服务端就已优先返回增强版。
  useEffect(() => {
    if (!session || enhanceInitializedRef.current) return;
    enhanceInitializedRef.current = true;
    if (isShareMode) {
      setAudioVariant('original');
      return;
    }
    const initial = session.audioEnhanceStatus ?? null;
    const ready = Boolean(session.enhancedAudioPath);
    setEnhanceStatus(initial);
    setEnhanceReady(ready);
    setAudioVariant(ready ? 'enhanced' : 'original');
    if (initial === 'pending' || initial === 'processing') {
      startEnhancePoll();
    } else {
      // 非进行中也拉一次：拿 available（按钮显隐）并对账最新状态
      void fetch(`/api/sessions/${sessionId}/enhance-status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!data) return;
          setEnhanceAvailable(Boolean(data.available));
          setEnhanceStatus(data.status ?? null);
          setEnhanceReady(Boolean(data.enhancedAudioReady));
        })
        .catch(() => undefined);
    }
  }, [session, isShareMode, sessionId, token, startEnhancePoll]);

  // 卸载时中止在途轮询
  useEffect(() => {
    return () => {
      enhancePollAbortRef.current?.abort();
    };
  }, []);

  if (!isShareMode && (!user || !token)) {
    return (
        <div className="h-screen flex items-center justify-center bg-cream-50">
        <div className="text-charcoal-400 text-sm">{t('playback.redirectingToLogin')}</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-cream-50">
        <div className="text-charcoal-400 text-sm">{t('playback.loadingSession')}</div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="h-screen flex items-center justify-center bg-cream-50">
        <div className="text-center">
          <p className="text-sm text-red-500 mb-3">{error || t('playback.sessionNotFound')}</p>
          <button onClick={() => router.push('/home')} className="text-xs text-rust-500 underline">
            {t('nav.backToHome')}
          </button>
        </div>
      </div>
    );
  }

  const audioTimelineDurationMs = audioSegments.reduce((maxDuration, segment) => {
    return Math.max(maxDuration, segment.startOffsetMs + segment.durationMs);
  }, 0);
  const effectiveDurationMs = Math.max(
    audioTimelineDurationMs,
    session.durationMs,
    segments.reduce((maxDuration, segment) => {
      const segmentEndMs =
        typeof segment.globalEndMs === 'number'
          ? segment.globalEndMs
          : segment.endMs;
      return Math.max(maxDuration, segmentEndMs);
    }, 0)
  );
  const progressWidth =
    effectiveDurationMs > 0
      ? `${Math.min(100, (currentTimeMs / effectiveDurationMs) * 100)}%`
      : '0%';
  const audioSourceValue = session.audioSource?.includes('system')
    ? t('playback.audioSourceSystem')
    : session.audioSource?.includes('microphone') || !session.audioSource
      ? t('playback.audioSourceMicrophone')
      : session.audioSource;

  /* ─── 移动端布局 ─── */
  if (isMobile) {
    return (
      <>
        <MobilePlaybackLayout
          session={session}
          segments={segments}
          summaries={summaries}
          reportData={reportData}
          reportLoading={reportLoading}
          isPlaying={isPlaying}
          currentTimeMs={currentTimeMs}
          effectiveDurationMs={effectiveDurationMs}
          playbackRate={playbackRate}
          volume={volume}
          muted={muted}
          onVolumeChange={setVolume}
          onToggleMuted={() => setMuted((m) => !m)}
          hasAudio={!!activeAudioSegment}
          onTogglePlayback={togglePlayback}
          onSeekToMs={seekToMs}
          onCycleSpeed={cycleSpeed}
          onSegmentClick={handleSegmentClickWithScroll}
          activeSegmentId={activeSegmentId}
          onOpenExport={() => setExportOpen(true)}
          onRegenerateTitle={handleRegenerateTitle}
          regeneratingTitle={regeneratingTitle}
          onRegenerateReport={handleRegenerateReport}
          regeneratingReport={regeneratingReport}
          isShareMode={isShareMode}
          canGenerateFull={canGenerateFull}
          onGenerateFull={handleGenerateFull}
          fullInProgress={fullInProgress}
          fullTriggering={fullTriggering}
          fullButtonLabel={fullButtonLabel}
          hasFullTranscript={hasFullTranscript}
          transcriptView={transcriptView}
          onSwitchTranscriptView={handleSwitchTranscriptView}
          displaySegments={displaySegments}
          fullLoaded={fullLoaded}
        />

        {/* 音频元素 — 移动端也需要 */}
        {activeAudioSegment && (
          <audio
            key={activeAudioSegment.url}
            ref={audioRef}
            src={activeAudioSegment.url}
            preload="auto"
            onLoadedMetadata={() => {
              const audio = audioRef.current;
              if (!audio) return;
              audio.playbackRate = playbackRate;
              audio.volume = volume;
              audio.muted = muted;
              if (pendingSeekMsRef.current !== null) {
                audio.currentTime = pendingSeekMsRef.current / 1000;
                pendingSeekMsRef.current = null;
              }
              syncPlaybackState({ resetClock: true });
              if (shouldResumePlaybackRef.current) {
                shouldResumePlaybackRef.current = false;
                const playPromise = audio.play();
                if (typeof playPromise?.then === 'function') {
                  void playPromise.then(
                    () => { setIsPlaying(true); isPlayingRef.current = true; syncPlaybackState({ resetClock: true }); startPlaybackClock(); },
                    () => { setIsPlaying(false); isPlayingRef.current = false; stopPlaybackClock(); }
                  );
                } else {
                  setIsPlaying(true); isPlayingRef.current = true; syncPlaybackState({ resetClock: true }); startPlaybackClock();
                }
              }
            }}
            onDurationChange={() => syncPlaybackState({ resetClock: true })}
            onPlay={() => { setIsPlaying(true); isPlayingRef.current = true; syncPlaybackState({ resetClock: true }); startPlaybackClock(); }}
            onPause={() => { setIsPlaying(false); isPlayingRef.current = false; syncPlaybackState({ resetClock: true }); stopPlaybackClock(); }}
            onSeeked={() => syncPlaybackState({ resetClock: true })}
            onTimeUpdate={() => syncPlaybackState()}
            onEnded={() => {
              const nextIndex = activeAudioIndexRef.current + 1;
              const nextSegment = audioSegmentsRef.current[nextIndex];
              if (nextSegment) {
                stopPlaybackClock();
                shouldResumePlaybackRef.current = true;
                pendingSeekMsRef.current = 0;
                primePlaybackClockState(nextIndex, 0);
                setActiveAudioIndex(nextIndex);
                setCurrentTimeMs(nextSegment.startOffsetMs);
                return;
              }
              setIsPlaying(false); isPlayingRef.current = false; syncPlaybackState({ resetClock: true }); stopPlaybackClock();
            }}
          />
        )}

        {session && (
          <ExportModal
            isOpen={exportOpen}
            onClose={() => setExportOpen(false)}
            sessionTitle={session.title}
            sessionId={session.id}
            sourceLang={session.sourceLang}
            targetLang={session.targetLang}
            segments={segments}
            translations={translations}
            summaries={summaryBlocksToResponses(summaries)}
            report={reportData}
            hasRecording={audioSegments.length > 0}
            fetchRecording={fetchRecordingForExport}
          />
        )}

        {/* 完整版转录·收费确认弹窗（移动端；desktop 分支末尾另有一份，二者互斥渲染） */}
        <ConfirmDialog
          open={fullConfirmOpen}
          title={t('playback.fullTranscribe.confirmTitle')}
          message={t('playback.fullTranscribe.confirmMessage', {
            minutes: String(fullEstimateMinutes),
          })}
          confirmText={t('playback.fullTranscribe.confirmCta', {
            minutes: String(fullEstimateMinutes),
          })}
          loading={fullTriggering}
          onConfirm={handleGenerateFullConfirm}
          onCancel={() => setFullConfirmOpen(false)}
        />
      </>
    );
  }

  /* ─── 桌面端布局 ─── */
  return (
    <div className="flex h-screen overflow-hidden">
      {!isShareMode && <Sidebar />}
      {!isShareMode && <UserSettingsModal />}

      <main
        className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${
          isShareMode ? '' : sidebarCollapsed ? 'ml-16' : 'ml-56'
        }`}
      >
        {/* Header */}
        <header className="flex-shrink-0 bg-white/95 backdrop-blur-md border-b border-cream-200 z-30">
          <div className="flex items-center justify-between px-5 py-3">
            <div className="flex items-center gap-3 min-w-0">
              {!isShareMode && (
                <button
                  onClick={() => router.push('/home')}
                  className="w-8 h-8 flex items-center justify-center rounded-lg
                             hover:bg-cream-100 text-charcoal-400 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
              )}

              <div className="min-w-0">
                <h1 className="font-serif font-bold text-charcoal-800 text-base leading-tight truncate">
                  {session.title}
                </h1>
                <div className="flex items-center gap-3 text-[11px] text-charcoal-400 mt-0.5">
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {formatDate(session.createdAt)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {formatDuration(effectiveDurationMs)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Globe className="w-3 h-3" />
                    {session.sourceLang.toUpperCase()} → {session.targetLang.toUpperCase()}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* 音频增强：就绪→「原声/增强」切换；进行中→加载态；可用未生成→触发按钮 */}
              {canEnhanceAudio && enhanceReady && (
                <div
                  className="inline-flex items-center rounded-lg bg-cream-100 p-0.5"
                  role="tablist"
                  aria-label={t('playback.audioEnhance.toggleLabel')}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={audioVariant === 'original'}
                    data-testid="audio-original"
                    onClick={() => handleSwitchAudioVariant('original')}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors ${
                      audioVariant === 'original'
                        ? 'bg-white text-charcoal-700 shadow-sm'
                        : 'text-charcoal-400 hover:text-charcoal-600'
                    }`}
                  >
                    {t('playback.audioEnhance.original')}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={audioVariant === 'enhanced'}
                    data-testid="audio-enhanced"
                    onClick={() => handleSwitchAudioVariant('enhanced')}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors flex items-center gap-1 ${
                      audioVariant === 'enhanced'
                        ? 'bg-white text-rust-600 shadow-sm'
                        : 'text-charcoal-400 hover:text-charcoal-600'
                    }`}
                  >
                    <AudioLines className="w-3 h-3" />
                    {t('playback.audioEnhance.enhanced')}
                  </button>
                </div>
              )}
              {canEnhanceAudio && !enhanceReady && enhanceInProgress && (
                <span
                  className="text-xs text-charcoal-400 flex items-center gap-1.5"
                  data-testid="enhance-processing"
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {t('playback.audioEnhance.processing')}
                </span>
              )}
              {canEnhanceAudio &&
                !enhanceReady &&
                !enhanceInProgress &&
                enhanceAvailable && (
                  <button
                    className="btn-ghost text-xs flex items-center gap-1.5"
                    onClick={handleTriggerEnhance}
                    disabled={enhanceTriggering}
                    data-testid="enhance-audio-btn"
                    title={t('playback.audioEnhance.hint')}
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
              {!isShareMode &&
                (session.status === 'COMPLETED' || session.status === 'ARCHIVED') &&
                Boolean(session.recordingPath) && (
                  <button
                    className="btn-ghost text-xs flex items-center gap-1.5"
                    onClick={handleGenerateFull}
                    disabled={fullInProgress || fullTriggering}
                    data-testid="full-transcribe-btn"
                    title={t('playback.fullTranscribe.button')}
                  >
                    {fullInProgress ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Layers className="w-3.5 h-3.5" />
                    )}
                    {fullInProgress
                      ? t(`playback.fullTranscribe.status${statusSuffix(fullStatus)}`)
                      : hasFullTranscript
                        ? t('playback.fullTranscribe.regenerate')
                        : t('playback.fullTranscribe.button')}
                  </button>
                )}
              {!isShareMode && (
                <button
                  className="btn-ghost text-xs flex items-center gap-1.5"
                  onClick={handleRegenerateTitle}
                  disabled={regeneratingTitle}
                  title={t('playback.regenerateTitle')}
                >
                  {regeneratingTitle
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <RefreshCw className="w-3.5 h-3.5" />}
                  {t('playback.regenerateTitle')}
                </button>
              )}
              {!isShareMode && <PlaybackSharePopover sessionId={sessionId} />}
              <button
                className="btn-ghost text-xs flex items-center gap-1.5"
                onClick={() => setExportOpen(true)}
              >
                <Download className="w-3.5 h-3.5" />
                {t('playback.export')}
              </button>
            </div>
          </div>
        </header>

        {/* Content: 2-column layout — 转录+翻译合并 | AI面板 */}
        <div className="flex-1 flex gap-4 p-4 min-h-0 overflow-hidden">
          {/* 转录 + 翻译（合并，原文在上翻译在下） */}
          <div className="min-w-0 flex-1 bg-white rounded-xl border border-cream-200 flex flex-col relative">
            <div className="px-4 py-3 border-b border-cream-100 flex items-center gap-2 flex-shrink-0">
              <FileText className="w-4 h-4 text-charcoal-400" />
              <span className="text-xs font-semibold text-charcoal-600">{t('playback.transcript')}</span>
              <span className="text-[10px] text-charcoal-400">
                {t('playback.transcriptSegments', { count: displaySegments.length })}
              </span>

              {/* 「实时 / 完整版」切换：仅完整版就绪后出现 */}
              {hasFullTranscript && (
                <div
                  className="ml-auto inline-flex items-center rounded-lg bg-cream-100 p-0.5"
                  role="tablist"
                  aria-label={t('playback.transcript')}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={transcriptView === 'live'}
                    data-testid="view-live"
                    onClick={() => handleSwitchTranscriptView('live')}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors ${
                      transcriptView === 'live'
                        ? 'bg-white text-charcoal-700 shadow-sm'
                        : 'text-charcoal-400 hover:text-charcoal-600'
                    }`}
                  >
                    {t('playback.fullTranscribe.viewLive')}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={transcriptView === 'full'}
                    data-testid="view-full"
                    onClick={() => handleSwitchTranscriptView('full')}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors ${
                      transcriptView === 'full'
                        ? 'bg-white text-rust-600 shadow-sm'
                        : 'text-charcoal-400 hover:text-charcoal-600'
                    }`}
                  >
                    {t('playback.fullTranscribe.viewFull')}
                  </button>
                </div>
              )}

              <span
                className={`text-[10px] text-charcoal-400 flex items-center gap-1 ${
                  hasFullTranscript ? '' : 'ml-auto'
                }`}
              >
                <Globe className="w-3 h-3" />
                {session.sourceLang.toUpperCase()} → {session.targetLang.toUpperCase()}
              </span>
            </div>

            <div
              ref={transcriptScrollRef}
              onScroll={handleTranscriptScroll}
              className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0"
            >
              {displaySegments.length === 0 ? (
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
                displaySegments.map((seg) => (
                  <div
                    key={seg.id}
                    ref={activeSegmentId === seg.id ? activeSegmentRef : undefined}
                    onClick={() => handleSegmentClickWithScroll(seg.globalStartMs)}
                    className={`p-3 rounded-lg cursor-pointer transition-colors ${
                      activeSegmentId === seg.id
                        ? 'bg-rust-50 border border-rust-200'
                        : 'hover:bg-cream-50 border border-transparent'
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
                    {/* 原文 */}
                    <p className="text-sm text-charcoal-800 leading-relaxed">{seg.text}</p>
                    {/* 翻译（同字号，紧跟原文下方） */}
                    {seg.translatedText && (
                      <p className="text-sm text-rust-600/80 leading-relaxed mt-1">
                        {seg.translatedText}
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* 滚动到当前播放位置按钮 */}
            {!transcriptAutoScroll && activeSegmentId && (
              <button
                onClick={() => {
                  setTranscriptAutoScroll(true);
                  userScrolledRef.current = false;
                }}
                className="absolute bottom-4 left-1/2 -translate-x-1/2
                           flex items-center gap-1.5 px-3 py-1.5 rounded-full
                           bg-charcoal-800/90 text-white text-xs font-medium
                           shadow-lg hover:bg-charcoal-700 transition-colors z-10"
              >
                <ChevronLeft className="w-3.5 h-3.5 rotate-[-90deg]" />
                {t('playback.scrollToCurrent')}
              </button>
            )}
          </div>

          {/* Right: AI Panel */}
          <div className="w-[380px] flex-shrink-0 bg-white rounded-xl border border-cream-200 flex flex-col">
            <div className="flex border-b border-cream-100 flex-shrink-0">
              {([
                { key: 'report' as const, icon: ClipboardList, label: t('playback.tabReport') },
                { key: 'summary' as const, icon: Sparkles, label: t('playback.tabSummary') },
                ...(!isShareMode ? [{ key: 'chat' as const, icon: MessageSquare, label: t('playback.tabChat') }] : []),
                { key: 'info' as const, icon: FileText, label: t('playback.tabInfo') },
              ] as { key: PlaybackTab; icon: typeof ClipboardList; label: string }[]).map(({ key, icon: Icon, label }) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium
                             transition-colors border-b-2 ${
                               activeTab === key
                                 ? 'border-rust-500 text-rust-600'
                                 : 'border-transparent text-charcoal-400 hover:text-charcoal-600'
                             }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-4 min-h-0">
              {activeTab === 'report' && (
                <div className="space-y-4">
                  {reportLoading ? (
                    <div className="text-center text-charcoal-400 text-sm py-8">
                      <ClipboardList className="w-6 h-6 mx-auto mb-2 opacity-30 animate-pulse" />
                      <p>{t('playback.loadingReport')}</p>
                    </div>
                  ) : !reportData ? (
                    <div className="text-center text-charcoal-400 text-sm py-8">
                      <ClipboardList className="w-6 h-6 mx-auto mb-2 opacity-30" />
                      <p>{t('playback.noReport')}</p>
                      {!isShareMode && (
                        <button
                          onClick={handleRegenerateReport}
                          disabled={regeneratingReport}
                          data-testid="report-regen-btn"
                          className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                                     bg-rust-50 text-rust-600 text-xs font-medium
                                     hover:bg-rust-100 disabled:opacity-50 disabled:cursor-not-allowed"
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
                      )}
                    </div>
                  ) : !reportData.significance.isWorthSummarizing ? (
                    <div className="text-center py-8">
                      <AlertCircle className="w-8 h-8 mx-auto mb-3 text-charcoal-300" />
                      <p className="text-sm text-charcoal-500 font-medium mb-1">{t('playback.insignificantTitle')}</p>
                      <p className="text-xs text-charcoal-400">{reportData.significance.reason}</p>
                      <div className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-cream-100 text-xs text-charcoal-500">
                        {t('playback.score', {
                          score: (reportData.significance.score * 100).toFixed(0),
                        })}
                      </div>
                    </div>
                  ) : reportData.report ? (
                    <div className="space-y-4">
                      {/* 报告标题 */}
                      <div className="pb-3 border-b border-cream-200">
                        <h3 className="font-serif font-bold text-charcoal-800 text-base leading-tight">
                          {reportData.report.title}
                        </h3>
                        <p className="text-xs text-charcoal-500 mt-1">{reportData.report.topic}</p>
                      </div>

                      {/* 元信息 */}
                      <div className="flex flex-wrap gap-3 text-[11px] text-charcoal-500">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" /> {reportData.report.date}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" /> {reportData.report.duration}
                        </span>
                        <span className="flex items-center gap-1">
                          <Users className="w-3 h-3" /> {reportData.report.participants.join(', ')}
                        </span>
                      </div>

                      {/* 概要 */}
                      <div className="p-3 rounded-lg bg-rust-50/50 border border-rust-100">
                        <p className="text-sm text-charcoal-700 leading-relaxed">{reportData.report.overview}</p>
                      </div>

                      {/* 分节内容 */}
                      {reportData.report.sections.map((section, i) => (
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
                      {reportData.report.conclusions.length > 0 && (
                        <div className="p-3 rounded-lg bg-emerald-50/50 border border-emerald-100">
                          <h4 className="text-xs font-semibold text-charcoal-700 mb-2 flex items-center gap-1.5">
                            <CheckSquare className="w-3 h-3 text-emerald-500" />
                            {t('playback.keyConclusions')}
                          </h4>
                          <ul className="space-y-1">
                            {reportData.report.conclusions.map((c, i) => (
                              <li key={i} className="text-xs text-charcoal-600 flex gap-1.5">
                                <span className="text-emerald-500 flex-shrink-0">✓</span>
                                <span>{c}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* 待办事项 */}
                      {reportData.report.actionItems.length > 0 && (
                        <div className="p-3 rounded-lg bg-amber-50/50 border border-amber-100">
                          <h4 className="text-xs font-semibold text-charcoal-700 mb-2 flex items-center gap-1.5">
                            <ClipboardList className="w-3 h-3 text-amber-500" />
                            {t('playback.actionItems')}
                          </h4>
                          <ul className="space-y-1">
                            {reportData.report.actionItems.map((item, i) => (
                              <li key={i} className="text-xs text-charcoal-600 flex gap-1.5">
                                <span className="text-amber-500 flex-shrink-0">□</span>
                                <span>{item}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* 关键术语 */}
                      {Object.keys(reportData.report.keyTerms).length > 0 && (
                        <div className="p-3 rounded-lg bg-cream-50 border border-cream-200">
                          <h4 className="text-xs font-semibold text-charcoal-700 mb-2 flex items-center gap-1.5">
                            <BookOpen className="w-3 h-3 text-charcoal-400" />
                            {t('playback.keyTerms')}
                          </h4>
                          <div className="space-y-1.5">
                            {Object.entries(reportData.report.keyTerms).map(([term, def]) => (
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
                  ) : (
                    <div className="text-center text-charcoal-400 text-sm py-8">
                      <AlertCircle className="w-6 h-6 mx-auto mb-2 opacity-30" />
                      <p>{t('playback.reportFailed')}</p>
                      {!isShareMode && (
                        <button
                          onClick={handleRegenerateReport}
                          disabled={regeneratingReport}
                          data-testid="report-regen-btn"
                          className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                                     bg-rust-50 text-rust-600 text-xs font-medium
                                     hover:bg-rust-100 disabled:opacity-50 disabled:cursor-not-allowed"
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
                      )}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'summary' && (
                <div className="space-y-4">
                  {summaries.length === 0 ? (
                    <div className="text-center text-charcoal-400 text-sm py-8">
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

              {activeTab === 'chat' && !isShareMode && (
                <ChatTab />
              )}

              {activeTab === 'info' && (
                <div className="space-y-3">
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
                    <div key={label} className="flex justify-between items-center py-1.5 border-b border-cream-100 last:border-0">
                      <span className="text-xs text-charcoal-400">{label}</span>
                      <span className="text-xs text-charcoal-700 font-medium">{value}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Bottom: Audio Player */}
        <div className="flex-shrink-0 border-t border-cream-200 bg-white px-5 py-3">
          <div className="flex items-center gap-4">
            {/* Play controls */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  seekToMs(currentTimeMs - 10000, { resumePlayback: isPlaying });
                }}
                className="w-8 h-8 flex items-center justify-center rounded-lg
                           hover:bg-cream-100 text-charcoal-500 transition-colors"
                title={t('playback.backTenSeconds')}
              >
                <SkipBack className="w-4 h-4" />
              </button>

              <button
                onClick={togglePlayback}
                disabled={!activeAudioSegment}
                className="w-10 h-10 flex items-center justify-center rounded-full
                           bg-rust-500 text-white hover:bg-rust-600 transition-colors
                           shadow-sm shadow-rust-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
              </button>

              <button
                onClick={() => {
                  seekToMs(currentTimeMs + 10000, { resumePlayback: isPlaying });
                }}
                className="w-8 h-8 flex items-center justify-center rounded-lg
                           hover:bg-cream-100 text-charcoal-500 transition-colors"
                title={t('playback.forwardTenSeconds')}
              >
                <SkipForward className="w-4 h-4" />
              </button>
            </div>

            {/* Time + progress bar */}
            <div className="flex-1 flex items-center gap-3">
              <span className="text-[11px] font-mono text-charcoal-500 tabular-nums w-16 text-right">
                {formatDuration(currentTimeMs)}
              </span>

              <div className="flex-1 h-1.5 bg-cream-200 rounded-full overflow-hidden cursor-pointer"
                onClick={(e) => {
                  if (!activeAudioSegment || effectiveDurationMs <= 0) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = (e.clientX - rect.left) / rect.width;
                  const nextTimeMs = Math.max(0, Math.min(effectiveDurationMs, effectiveDurationMs * pct));
                  seekToMs(nextTimeMs, { resumePlayback: isPlaying });
                }}
              >
                <div
                  className="h-full bg-rust-500 rounded-full transition-all duration-100"
                  style={{ width: progressWidth }}
                />
              </div>

              <span className="text-[11px] font-mono text-charcoal-400 tabular-nums w-16">
                {formatDuration(effectiveDurationMs)}
              </span>
            </div>

            {/* Speed + Volume */}
            <div className="flex items-center gap-2">
              <button
                onClick={cycleSpeed}
                className="px-2 py-1 rounded-md text-[11px] font-mono font-medium
                           border border-cream-300 text-charcoal-600 hover:bg-cream-50 transition-colors"
              >
                {playbackRate}x
              </button>
              <div className="group/vol flex items-center gap-1.5 px-1.5 py-1 rounded-md hover:bg-cream-50 transition-colors">
                <button
                  onClick={() => setMuted((m) => !m)}
                  className="text-charcoal-500 hover:text-charcoal-700 transition-colors"
                  aria-label={muted ? t('common.unmute') : t('common.mute')}
                  title={muted ? t('common.unmute') : t('common.mute')}
                >
                  {muted || volume === 0 ? (
                    <VolumeX className="w-4 h-4" />
                  ) : volume < 0.5 ? (
                    <Volume1 className="w-4 h-4" />
                  ) : (
                    <Volume2 className="w-4 h-4" />
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
                    setVolume(next);
                    if (next > 0 && muted) setMuted(false);
                  }}
                  className="playback-volume-slider w-20"
                  style={{
                    background: `linear-gradient(to right, #C44B20 0%, #C44B20 ${(muted ? 0 : volume) * 100}%, #E8DFD0 ${(muted ? 0 : volume) * 100}%, #E8DFD0 100%)`,
                  }}
                  aria-label={t('common.volume')}
                />
              </div>
            </div>
          </div>

          {/* Audio element — 使用 blob URL 避免 auth 问题 */}
          {activeAudioSegment && (
            <audio
              key={activeAudioSegment.url}
              ref={audioRef}
              src={activeAudioSegment.url}
              preload="auto"
              onLoadedMetadata={() => {
                const audio = audioRef.current;
                if (!audio) {
                  return;
                }

                audio.playbackRate = playbackRate;
                audio.volume = volume;
                audio.muted = muted;
                if (pendingSeekMsRef.current !== null) {
                  audio.currentTime = pendingSeekMsRef.current / 1000;
                  pendingSeekMsRef.current = null;
                }
                syncPlaybackState({ resetClock: true });

                if (shouldResumePlaybackRef.current) {
                  shouldResumePlaybackRef.current = false;
                  const playPromise = audio.play();
                  if (typeof playPromise?.then === 'function') {
                    void playPromise.then(
                      () => {
                        setIsPlaying(true);
                        isPlayingRef.current = true;
                        syncPlaybackState({ resetClock: true });
                        startPlaybackClock();
                      },
                      () => {
                        setIsPlaying(false);
                        isPlayingRef.current = false;
                        stopPlaybackClock();
                      }
                    );
                  } else {
                    setIsPlaying(true);
                    isPlayingRef.current = true;
                    syncPlaybackState({ resetClock: true });
                    startPlaybackClock();
                  }
                }
              }}
              onDurationChange={() => {
                syncPlaybackState({ resetClock: true });
              }}
              onPlay={() => {
                setIsPlaying(true);
                isPlayingRef.current = true;
                syncPlaybackState({ resetClock: true });
                startPlaybackClock();
              }}
              onPause={() => {
                setIsPlaying(false);
                isPlayingRef.current = false;
                syncPlaybackState({ resetClock: true });
                stopPlaybackClock();
              }}
              onSeeked={() => {
                syncPlaybackState({ resetClock: true });
              }}
              onTimeUpdate={() => {
                syncPlaybackState();
              }}
              onEnded={() => {
                const nextIndex = activeAudioIndexRef.current + 1;
                const nextSegment = audioSegmentsRef.current[nextIndex];
                if (nextSegment) {
                  stopPlaybackClock();
                  shouldResumePlaybackRef.current = true;
                  pendingSeekMsRef.current = 0;
                  primePlaybackClockState(nextIndex, 0);
                  setActiveAudioIndex(nextIndex);
                  setCurrentTimeMs(nextSegment.startOffsetMs);
                  return;
                }

                setIsPlaying(false);
                isPlayingRef.current = false;
                syncPlaybackState({ resetClock: true });
                stopPlaybackClock();
              }}
            />
          )}
        </div>
      </main>

      {session && (
        <ExportModal
          isOpen={exportOpen}
          onClose={() => setExportOpen(false)}
          sessionTitle={session.title}
          sessionId={session.id}
          sourceLang={session.sourceLang}
          targetLang={session.targetLang}
          segments={segments}
          translations={translations}
          summaries={summaryBlocksToResponses(summaries)}
          report={reportData}
          hasRecording={audioSegments.length > 0}
          fetchRecording={fetchRecordingForExport}
        />
      )}
      <ConfirmDialog
        open={regenerateConfirmOpen}
        title={t('playback.regenerateTitle')}
        message={t('playback.regenerateTitleConfirm')}
        confirmText={t('playback.regenerateTitle')}
        loading={regeneratingTitle}
        onConfirm={handleRegenerateTitleConfirm}
        onCancel={() => setRegenerateConfirmOpen(false)}
      />
      {/* 完整版转录·收费确认弹窗（不可省，用户明确要求点击前清楚提示计费） */}
      <ConfirmDialog
        open={fullConfirmOpen}
        title={t('playback.fullTranscribe.confirmTitle')}
        message={t('playback.fullTranscribe.confirmMessage', {
          minutes: String(fullEstimateMinutes),
        })}
        confirmText={t('playback.fullTranscribe.confirmCta', {
          minutes: String(fullEstimateMinutes),
        })}
        loading={fullTriggering}
        onConfirm={handleGenerateFullConfirm}
        onCancel={() => setFullConfirmOpen(false)}
      />
    </div>
  );
}
