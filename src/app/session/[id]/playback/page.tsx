'use client';

// v2.1 §C.4: Independent playback view for COMPLETED/ARCHIVED sessions
// Completely separate from the recording view — focused on review & audio playback

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import ExportModal from '@/components/ExportModal';
import MobilePlaybackLayout from '@/components/mobile/MobilePlaybackLayout';
import ChatTab from '@/components/session/ChatTab';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useI18n } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAuthStore } from '@/stores/authStore';
import { useTranscriptStore } from '@/stores/transcriptStore';
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
  ClipboardList,
  Users,
  Target,
  CheckSquare,
  BookOpen,
  AlertCircle,
} from 'lucide-react';
import type { TranscriptSegment } from '@/types/transcript';
import type { SummaryBlock } from '@/types/summary';
import type { SessionReportData } from '@/types/report';

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
    const timeoutId = window.setTimeout(() => {
      const durationMs =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000
          : 0;
      finish(durationMs);
    }, 2000);

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
  const sessionId = params.id as string;
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
  const clearTranslations = useTranslationStore((s) => s.clearAll);
  const restoreAttemptedRef = useRef(false);

  const [session, setSession] = useState<SessionData | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [summaries, setSummaries] = useState<SummaryBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PlaybackTab>('report');
  const [exportOpen, setExportOpen] = useState(false);
  const [reportData, setReportData] = useState<SessionReportData | null>(null);
  const [reportLoading, setReportLoading] = useState(false);

  // Audio player state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [audioSegments, setAudioSegments] = useState<PlaybackAudioSegment[]>([]);
  const [activeAudioIndex, setActiveAudioIndex] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioSegmentsRef = useRef<PlaybackAudioSegment[]>([]);
  const activeAudioIndexRef = useRef(0);
  const isPlayingRef = useRef(false);
  const playbackClockRef = useRef<number | null>(null);
  const playbackClockStateRef = useRef<PlaybackClockState | null>(null);
  const shouldResumePlaybackRef = useRef(false);
  const pendingSeekMsRef = useRef<number | null>(null);

  // Auth guard — 和 session page 一样防止水合竞态
  useEffect(() => {
    if (user && token) return;
    if (!restoreAttemptedRef.current) {
      restoreAttemptedRef.current = true;
      restoreSession().then((ok) => {
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
  }, [user, token, router, restoreSession]);

  // Fetch session data + transcript
  useEffect(() => {
    if (!token) return;
    setLoading(true);

    const headers = { Authorization: `Bearer ${token}` };

    fetch(`/api/sessions/${sessionId}`, { headers })
      .then((r) => r.json())
      .then(async (data) => {
        if (data.error) {
          setError(data.error);
          return;
        }
        // If session is still recording, redirect to live page
        if (['CREATED', 'RECORDING', 'PAUSED', 'FINALIZING'].includes(data.status)) {
          router.replace(`/session/${sessionId}`);
          return;
        }
        setSession(data);

        // Load transcript and summary data
        try {
          const tRes = await fetch(`/api/sessions/${sessionId}/transcript`, { headers });
          if (tRes.ok) {
            const tData = await tRes.json();
            if (Array.isArray(tData.segments)) {
              // Merge translations into segments
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
          const rRes = await fetch(`/api/llm/report?sessionId=${sessionId}`, { headers });
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
  }, [sessionId, token, router, t]);

  // 带 auth header 加载音频，必要时拆成多个连续 WebM 段
  useEffect(() => {
    if (!token || !sessionId) return;
    let disposed = false;
    const createdUrls: string[] = [];

    fetch(`/api/sessions/${sessionId}/audio`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('Audio load failed');
        const mimeType = res.headers.get('content-type') || 'audio/webm';
        const buffer = await res.arrayBuffer();
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

        let nextOffsetMs = 0;
        const nextSegments = segmentsWithUrls.map(({ url }, index) => {
          const segment: PlaybackAudioSegment = {
            url,
            durationMs: durations[index],
            startOffsetMs: nextOffsetMs,
          };
          nextOffsetMs += durations[index];
          return segment;
        });

        setAudioSegments(nextSegments);
        setActiveAudioIndex(0);
        setCurrentTimeMs(0);
        setIsPlaying(false);
      })
      .catch((err) => {
        console.error('Failed to load audio:', err);
      });

    return () => {
      disposed = true;
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
      setAudioSegments([]);
      setActiveAudioIndex(0);
    };
  }, [token, sessionId]);

  // Sync to stores (for ChatTab / ExportModal)
  useEffect(() => {
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
      clearTranscript();
      clearSummaries();
      clearTranslations();
    };
  }, [
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
    audioSegmentsRef.current = audioSegments;
  }, [audioSegments]);

  useEffect(() => {
    activeAudioIndexRef.current = activeAudioIndex;
  }, [activeAudioIndex]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

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

  // Determine which segment is "active" based on current playback time
  const activeSegmentId = segments.find(
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

  if (!user || !token) {
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
          hasAudio={!!activeAudioSegment}
          onTogglePlayback={togglePlayback}
          onSeekToMs={seekToMs}
          onCycleSpeed={cycleSpeed}
          onSegmentClick={handleSegmentClickWithScroll}
          activeSegmentId={activeSegmentId}
          onOpenExport={() => setExportOpen(true)}
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
          />
        )}
      </>
    );
  }

  /* ─── 桌面端布局 ─── */
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />

      <main
        className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${
          sidebarCollapsed ? 'ml-16' : 'ml-56'
        }`}
      >
        {/* Header */}
        <header className="flex-shrink-0 bg-white/95 backdrop-blur-md border-b border-cream-200 z-30">
          <div className="flex items-center justify-between px-5 py-3">
            <div className="flex items-center gap-3 min-w-0">
              <button
                onClick={() => router.push('/home')}
                className="w-8 h-8 flex items-center justify-center rounded-lg
                           hover:bg-cream-100 text-charcoal-400 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

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

            <button
              className="btn-ghost text-xs flex items-center gap-1.5"
              onClick={() => setExportOpen(true)}
            >
              <Download className="w-3.5 h-3.5" />
              {t('playback.export')}
            </button>
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
                {t('playback.transcriptSegments', { count: segments.length })}
              </span>
              <span className="text-[10px] text-charcoal-400 ml-auto flex items-center gap-1">
                <Globe className="w-3 h-3" />
                {session.sourceLang.toUpperCase()} → {session.targetLang.toUpperCase()}
              </span>
            </div>

            <div
              ref={transcriptScrollRef}
              onScroll={handleTranscriptScroll}
              className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0"
            >
              {segments.length === 0 ? (
                <div className="text-center text-charcoal-400 text-sm py-12">
                  <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p>{t('playback.transcriptEmpty')}</p>
                </div>
              ) : (
                segments.map((seg) => (
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
              {[
                { key: 'report' as const, icon: ClipboardList, label: t('playback.tabReport') },
                { key: 'summary' as const, icon: Sparkles, label: t('playback.tabSummary') },
                { key: 'chat' as const, icon: MessageSquare, label: t('playback.tabChat') },
                { key: 'info' as const, icon: FileText, label: t('playback.tabInfo') },
              ].map(({ key, icon: Icon, label }) => (
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

              {activeTab === 'chat' && (
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
              <Volume2 className="w-4 h-4 text-charcoal-400" />
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
        />
      )}
    </div>
  );
}
