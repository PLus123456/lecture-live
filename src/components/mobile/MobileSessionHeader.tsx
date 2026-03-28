'use client';

import { useRouter } from 'next/navigation';
import {
  Check,
  Copy,
  Download,
  Ellipsis,
  Link2,
  Pause,
  PictureInPicture2,
  Radio,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { BackupMeta, ConnectionMeta } from '@/stores/transcriptStore';
import ActionSheet, { type ActionSheetItem } from '@/components/mobile/ActionSheet';
import { useI18n } from '@/lib/i18n';
import type { RecordingState } from '@/types/transcript';

interface MobileSessionHeaderProps {
  title: string;
  isEditing: boolean;
  editingTitle: string;
  titleInputRef: React.RefObject<HTMLInputElement>;
  onStartEdit: () => void;
  onConfirmEdit: () => void;
  onCancelEdit: () => void;
  onEditChange: (value: string) => void;
  recordingState: RecordingState;
  connectionState: string;
  elapsed: number;
  connectionMeta: ConnectionMeta;
  onOpenSettings: () => void;
  onOpenExport: () => void;
  onToggleShare: () => void;
  onCopyShareLink?: () => void;
  onTogglePip: () => void;
  isSharing: boolean;
  shareUrl?: string | null;
  pipOpen: boolean;
  serviceAvailable: boolean | null;
  backupMeta: BackupMeta;
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

function getBadgeStyles(
  recordingState: RecordingState,
  connectionState: string,
  t: (key: string, params?: Record<string, string | number>) => string
) {
  if (connectionState === 'error') {
    return {
      dot: 'bg-red-500',
      text: 'text-red-700',
      bg: 'bg-red-50 border-red-200',
      label: t('session.status.error'),
    };
  }

  if (recordingState === 'recording') {
    return {
      dot: 'bg-red-500',
      text: 'text-red-700',
      bg: 'bg-red-50 border-red-200',
      label: t('session.status.recording'),
    };
  }

  if (recordingState === 'paused') {
    return {
      dot: 'bg-amber-500',
      text: 'text-amber-700',
      bg: 'bg-amber-50 border-amber-200',
      label: t('session.status.paused'),
    };
  }

  if (recordingState === 'finalizing') {
    return {
      dot: 'bg-sky-500',
      text: 'text-sky-700',
      bg: 'bg-sky-50 border-sky-200',
      label: t('mobileControl.saving'),
    };
  }

  if (recordingState === 'stopped') {
    return {
      dot: 'bg-emerald-500',
      text: 'text-emerald-700',
      bg: 'bg-emerald-50 border-emerald-200',
      label: t('mobileControl.saved'),
    };
  }

  return {
    dot: 'bg-charcoal-300',
    text: 'text-charcoal-600',
    bg: 'bg-cream-50 border-cream-200',
    label: t('mobileControl.ready'),
  };
}

function getBackupText(
  backupMeta: BackupMeta,
  t: (key: string, params?: Record<string, string | number>) => string
) {
  const stateKey =
    backupMeta.syncState === 'synced'
      ? 'session.backup.audioSafe'
      : backupMeta.syncState === 'syncing'
        ? 'session.backup.backingUp'
        : backupMeta.syncState === 'error'
          ? 'session.backup.backupRetry'
          : backupMeta.syncState === 'pending'
            ? 'session.backup.localSafe'
            : 'session.backup.backupIdle';

  if (backupMeta.localChunkCount === 0) {
    return t('session.backup.backupIdle');
  }

  return `${t(stateKey)} · ${t('session.backup.chunkProgress', {
    have: Math.min(backupMeta.remoteChunkCount, backupMeta.localChunkCount),
    total: backupMeta.localChunkCount,
  })}`;
}

export default function MobileSessionHeader({
  title,
  isEditing,
  editingTitle,
  titleInputRef,
  onStartEdit,
  onConfirmEdit,
  onCancelEdit,
  onEditChange,
  recordingState,
  connectionState,
  elapsed,
  connectionMeta,
  onOpenSettings,
  onOpenExport,
  onToggleShare,
  onCopyShareLink,
  onTogglePip,
  isSharing,
  shareUrl,
  pipOpen,
  serviceAvailable,
  backupMeta,
}: MobileSessionHeaderProps) {
  const router = useRouter();
  const { t } = useI18n();
  const [sheetOpen, setSheetOpen] = useState(false);
  const badge = getBadgeStyles(recordingState, connectionState, t);

  const items = useMemo<ActionSheetItem[]>(() => {
    const baseItems: ActionSheetItem[] = [
      {
        key: 'export',
        label: t('common.download'),
        description: t('mobile.exportDesc'),
        icon: <Download className="h-4 w-4" />,
        onSelect: onOpenExport,
      },
      {
        key: 'share',
        label: isSharing ? t('mobile.stopLiveShare') : t('mobile.startLiveShare'),
        description: isSharing
          ? t('mobile.stopLiveShareDesc')
          : t('mobile.startLiveShareDesc'),
        icon: isSharing ? <Radio className="h-4 w-4" /> : <Link2 className="h-4 w-4" />,
        onSelect: onToggleShare,
      },
    ];

    if (isSharing && shareUrl && onCopyShareLink) {
      baseItems.push({
        key: 'copy-share',
        label: t('mobile.copyShareLink'),
        description: t('mobile.copyShareLinkDesc'),
        icon: <Copy className="h-4 w-4" />,
        onSelect: onCopyShareLink,
      });
    }

    baseItems.push({
      key: 'pip',
      label: pipOpen ? t('mobile.closePip') : t('mobile.openPip'),
      description: t('mobile.pipDesc'),
      icon: <PictureInPicture2 className="h-4 w-4" />,
      onSelect: onTogglePip,
    });

    baseItems.push({
      key: 'backup',
      label: t('mobile.backupStatus'),
      description: getBackupText(backupMeta, t),
      icon: <ShieldCheck className="h-4 w-4" />,
      disabled: true,
      onSelect: () => undefined,
    });

    return baseItems;
  }, [backupMeta, isSharing, onCopyShareLink, onOpenExport, onTogglePip, onToggleShare, pipOpen, shareUrl, t]);

  return (
    <>
      <header className="safe-top border-b border-cream-200 bg-white/95 px-3 pb-2 pt-3 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.back()}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-cream-100 text-charcoal-600"
            aria-label={t('mobile.goBack')}
          >
            <span className="text-lg leading-none">←</span>
          </button>

          <div className="min-w-0 flex-1">
            {isEditing ? (
              <div className="flex items-center gap-2">
                <input
                  ref={titleInputRef}
                  value={editingTitle}
                  onChange={(event) => onEditChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      onConfirmEdit();
                    }
                    if (event.key === 'Escape') {
                      onCancelEdit();
                    }
                  }}
                  className="w-full rounded-xl border border-rust-300 bg-white px-3 py-2 text-sm font-semibold text-charcoal-800 outline-none focus:border-rust-400"
                  autoFocus
                />
                <button
                  onClick={onConfirmEdit}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-rust-500 text-white"
                >
                  <Check className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={onStartEdit}
                className="block max-w-full text-left"
              >
                <div className="truncate text-base font-semibold text-charcoal-800">{title}</div>
                <div className="mt-0.5 flex items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${badge.bg} ${badge.text}`}
                  >
                    <span className={`h-2 w-2 rounded-full ${badge.dot}`} />
                    {badge.label}
                  </span>
                  <span className="font-mono text-[11px] text-charcoal-500">
                    {formatDuration(elapsed)}
                  </span>
                  {recordingState !== 'idle' && connectionMeta.region ? (
                    <span className="text-[11px] text-charcoal-400">
                      {connectionMeta.region.toUpperCase()}
                    </span>
                  ) : null}
                </div>
              </button>
            )}
          </div>

          <button
            onClick={onOpenSettings}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-cream-100 text-charcoal-600"
            aria-label={t('mobile.openSettings')}
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            onClick={() => setSheetOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-cream-100 text-charcoal-600"
            aria-label={t('mobile.moreActions')}
          >
            <Ellipsis className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-2 flex items-center justify-between text-[11px] text-charcoal-400">
          <span>
            {connectionMeta.transcriptionLatencyMs != null
              ? t('mobile.latency', { ms: connectionMeta.transcriptionLatencyMs })
              : connectionMeta.latencyMs != null
                ? t('mobile.network', { ms: connectionMeta.latencyMs })
                : serviceAvailable === false
                  ? t('mobile.speechUnavailable')
                  : t('mobile.waitingLiveTranscription')}
          </span>
          {recordingState === 'paused' ? (
            <span className="inline-flex items-center gap-1 text-amber-700">
              <Pause className="h-3 w-3" />
              {t('session.status.paused')}
            </span>
          ) : null}
        </div>
      </header>

      <ActionSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={t('mobile.sessionActions')}
        items={items}
      />
    </>
  );
}
