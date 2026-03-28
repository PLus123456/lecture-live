'use client';

import { useEffect, useState } from 'react';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useI18n } from '@/lib/i18n';
import {
  Circle,
  Pause,
  Square,
  Download,
  Radio,
} from 'lucide-react';
import ConnectionStatus from './ConnectionStatus';
import MicSelector from './session/MicSelector';
import LiveShareBadge from './session/LiveShareBadge';

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export default function ControlBar({
  onStart,
  onPause,
  onStop,
  onExport,
  onShareLive,
  onMicSwitch,
}: {
  onStart?: () => void;
  onPause?: () => void;
  onStop?: () => void;
  onExport?: () => void;
  onShareLive?: () => void;
  onMicSwitch?: (deviceId: string) => void;
}) {
  const { t } = useI18n();
  const recordingState = useTranscriptStore((s) => s.recordingState);
  const recordingStartTime = useTranscriptStore((s) => s.recordingStartTime);
  const totalPausedMs = useTranscriptStore((s) => s.totalPausedMs);
  const pausedAt = useTranscriptStore((s) => s.pausedAt);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (recordingState === 'recording' && recordingStartTime) {
      const interval = setInterval(() => {
        setElapsed(Date.now() - recordingStartTime - totalPausedMs);
      }, 1000);
      return () => clearInterval(interval);
    }
    if (recordingState === 'paused' && recordingStartTime && pausedAt) {
      // Freeze the timer at the moment of pause
      setElapsed(pausedAt - recordingStartTime - totalPausedMs);
    }
  }, [recordingState, recordingStartTime, totalPausedMs, pausedAt]);

  const isRecording = recordingState === 'recording';
  const isPaused = recordingState === 'paused';
  const isStopped = recordingState === 'stopped';
  const isIdle = recordingState === 'idle';

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50
                 bg-white/95 backdrop-blur-md border-t border-cream-200
                 shadow-[0_-4px_20px_rgba(0,0,0,0.05)]"
    >
      <div className="px-6 py-3 flex items-center justify-between">
        {/* Left: Status */}
        <div className="flex items-center gap-4 min-w-[200px]">
          <ConnectionStatus />
          {(isRecording || isPaused) && (
            <div className="flex items-center gap-2">
              <div
                className={`w-2.5 h-2.5 rounded-full ${
                  isRecording
                    ? 'bg-red-500 recording-pulse'
                    : 'bg-yellow-500'
                }`}
              />
              <span className="text-sm font-mono text-charcoal-600">
                {formatDuration(elapsed)}
              </span>
            </div>
          )}
          <LiveShareBadge />
        </div>

        {/* Center: Controls */}
        <div className="flex items-center gap-3">
          {(isIdle || isStopped) && (
            <button
              onClick={onStart}
              className="flex items-center gap-2 bg-rust-500 text-white
                         px-6 py-2.5 rounded-full font-medium text-sm
                         hover:bg-rust-600 active:bg-rust-700 transition-colors
                         shadow-md shadow-rust-500/20"
            >
              <Circle className="w-4 h-4 fill-current" />
              {isStopped ? t('session.newSession.title') : t('session.newSession.startRecording')}
            </button>
          )}

          {isRecording && (
            <>
              <button
                onClick={onPause}
                className="flex items-center justify-center w-11 h-11 rounded-full
                           bg-cream-200 text-charcoal-600 hover:bg-cream-300 transition-colors"
                title={t('common.pause')}
              >
                <Pause className="w-5 h-5" />
              </button>
              <button
                onClick={onStop}
                className="flex items-center justify-center w-11 h-11 rounded-full
                           bg-charcoal-800 text-white hover:bg-charcoal-700 transition-colors"
                title={t('common.stop')}
              >
                <Square className="w-4 h-4 fill-current" />
              </button>
            </>
          )}

          {isPaused && (
            <>
              <button
                onClick={onStart}
                className="flex items-center gap-2 bg-rust-500 text-white
                           px-6 py-2.5 rounded-full font-medium text-sm
                           hover:bg-rust-600 transition-colors shadow-md shadow-rust-500/20"
              >
                <Circle className="w-4 h-4 fill-current" />
                {t('common.resume')}
              </button>
              <button
                onClick={onStop}
                className="flex items-center justify-center w-11 h-11 rounded-full
                           bg-charcoal-800 text-white hover:bg-charcoal-700 transition-colors"
                title={t('common.stop')}
              >
                <Square className="w-4 h-4 fill-current" />
              </button>
            </>
          )}
        </div>

        {/* Right: Share, Mic, Export */}
        <div className="flex items-center gap-2 min-w-[280px] justify-end">
          {isRecording && (
            <>
              {onShareLive && (
                <button
                  onClick={onShareLive}
                  className="btn-ghost text-xs flex items-center gap-1.5"
                >
                  <Radio className="w-3.5 h-3.5" />
                  {t('session.share.title')}
                </button>
              )}
              <MicSelector onSwitch={onMicSwitch} />
            </>
          )}
          <button
            onClick={onExport}
            disabled={isIdle}
            className="btn-ghost text-xs flex items-center gap-1.5 disabled:opacity-30"
          >
            <Download className="w-3.5 h-3.5" />
            {t('common.download')}
          </button>
        </div>
      </div>
    </div>
  );
}
