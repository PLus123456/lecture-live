'use client';

import {
  Circle,
  Loader2,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Square,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import type { RecordingState } from '@/types/transcript';

interface MobileControlBarProps {
  recordingState: RecordingState;
  connectionState: string;
  elapsed: number;
  serviceAvailable: boolean | null;
  hasPendingSave: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRetry: () => void;
  onViewPlayback: () => void;
}

function formatDuration(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours.toString().padStart(2, '0')}:${minutes
    .toString()
    .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function ControlButton({
  label,
  icon,
  onClick,
  variant = 'default',
  disabled = false,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'danger' | 'default';
  disabled?: boolean;
}) {
  const className =
    variant === 'primary'
      ? 'bg-rust-500 text-white shadow-rust-500/20'
      : variant === 'danger'
        ? 'bg-charcoal-800 text-white'
        : 'bg-cream-100 text-charcoal-700';

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex min-w-[44px] items-center justify-center gap-1 rounded-full px-3 py-2 text-xs font-semibold transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function MicIndicator({ active }: { active: boolean }) {
  const heights = [10, 16, 20, 14, 8];

  return (
    <div className="flex items-end gap-1 rounded-full bg-cream-100 px-2 py-2">
      <Mic className={`h-4 w-4 ${active ? 'text-rust-500' : 'text-charcoal-300'}`} />
      <div className="flex items-end gap-[3px]">
        {heights.map((height, index) => (
          <span
            key={height}
            className={`block w-[3px] rounded-full ${active ? 'bg-rust-400 animate-pulse' : 'bg-charcoal-200'}`}
            style={{
              height,
              animationDelay: `${index * 120}ms`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

export default function MobileControlBar({
  recordingState,
  connectionState,
  elapsed,
  serviceAvailable,
  hasPendingSave,
  onStart,
  onPause,
  onResume,
  onStop,
  onRetry,
  onViewPlayback,
}: MobileControlBarProps) {
  const { t } = useI18n();
  const isRecording = recordingState === 'recording';
  const isPaused = recordingState === 'paused';
  const isStopped = recordingState === 'stopped';
  const isFinalizing = recordingState === 'finalizing';
  const isIdle = recordingState === 'idle';
  const showUnavailable = isIdle && serviceAvailable === false;

  const label = isFinalizing
    ? t('mobileControl.finalizing')
    : isRecording
      ? t('session.status.recording')
      : isPaused
        ? hasPendingSave
          ? t('session.actions.retrySave')
          : t('session.status.paused')
        : isStopped
          ? t('mobileControl.saved')
          : connectionState === 'error'
            ? t('session.status.error')
            : t('mobileControl.ready');

  return (
    <div className="border-t border-cream-200 bg-white/95 px-3 py-3 shadow-[0_-4px_20px_rgba(0,0,0,0.05)] backdrop-blur-md safe-bottom">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                isRecording
                  ? 'bg-red-500 recording-pulse'
                  : isPaused
                    ? 'bg-amber-500'
                    : isStopped
                      ? 'bg-emerald-500'
                      : showUnavailable
                        ? 'bg-red-500'
                        : 'bg-charcoal-300'
              }`}
            />
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-charcoal-500">
              {label}
            </span>
            <span className="font-mono text-sm text-charcoal-700">{formatDuration(elapsed)}</span>
          </div>
          <p className="mt-1 truncate text-[11px] text-charcoal-400">
            {showUnavailable
              ? t('mobileControl.speechUnavailable')
              : isFinalizing
                ? t('mobileControl.keepPageOpen')
                : connectionState === 'error'
                  ? t('mobileControl.connectionInterrupted')
                  : isStopped
                    ? t('mobileControl.recordingCompleted')
                    : t('mobileControl.controlsAvailable')}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isIdle ? (
            <ControlButton
              label={t('common.start')}
              icon={<Circle className="h-4 w-4 fill-current" />}
              onClick={onStart}
              variant="primary"
              disabled={showUnavailable}
            />
          ) : null}

          {isRecording ? (
            <>
              <ControlButton
                label={t('common.pause')}
                icon={<Pause className="h-4 w-4" />}
                onClick={onPause}
              />
              <ControlButton
                label={t('common.stop')}
                icon={<Square className="h-4 w-4 fill-current" />}
                onClick={onStop}
                variant="danger"
              />
            </>
          ) : null}

          {isPaused ? (
            <>
              <ControlButton
                label={hasPendingSave ? t('common.retry') : t('common.resume')}
                icon={
                  hasPendingSave ? (
                    <RefreshCw className="h-4 w-4" />
                  ) : (
                    <Play className="h-4 w-4 fill-current" />
                  )
                }
                onClick={hasPendingSave ? onRetry : onResume}
                variant="primary"
              />
              <ControlButton
                label={t('common.stop')}
                icon={<Square className="h-4 w-4 fill-current" />}
                onClick={onStop}
                variant="danger"
              />
            </>
          ) : null}

          {isFinalizing ? (
            <div className="flex items-center gap-2 rounded-full bg-rust-50 px-4 py-2 text-xs font-semibold text-rust-600">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('mobileControl.saving')}
            </div>
          ) : null}

          {isStopped ? (
            <ControlButton
              label={t('common.view')}
              icon={<Play className="h-4 w-4 fill-current" />}
              onClick={onViewPlayback}
              variant="primary"
            />
          ) : null}

          <MicIndicator active={isRecording || isPaused} />
        </div>
      </div>
    </div>
  );
}
