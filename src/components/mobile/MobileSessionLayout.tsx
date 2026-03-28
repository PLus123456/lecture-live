'use client';

import { useMemo, useRef, useState } from 'react';
import TranscriptPanel from '@/components/TranscriptPanel';
import TranslationPanel from '@/components/TranslationPanel';
import SummaryTab from '@/components/session/SummaryTab';
import ChatTab from '@/components/session/ChatTab';
import KeywordTab from '@/components/session/KeywordTab';
import MobileContentTabs, { type MobileTab } from '@/components/mobile/MobileContentTabs';
import MobileControlBar from '@/components/mobile/MobileControlBar';
import MobileSessionHeader from '@/components/mobile/MobileSessionHeader';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { useSwipeGesture } from '@/hooks/useSwipeGesture';
import type { BackupMeta, ConnectionMeta } from '@/stores/transcriptStore';
import type { RecordingState } from '@/types/transcript';

interface MobileSessionLayoutProps {
  sessionId: string;
  sessionTitle: string;
  isEditingTitle: boolean;
  editingTitle: string;
  titleInputRef: React.RefObject<HTMLInputElement>;
  onStartEditTitle: () => void;
  onConfirmTitle: () => void;
  onCancelTitleEdit: () => void;
  onEditTitleChange: (value: string) => void;
  recordingState: RecordingState;
  connectionState: string;
  connectionMeta: ConnectionMeta;
  elapsed: number;
  backupMeta: BackupMeta;
  serviceAvailable: boolean | null;
  hasPendingSave: boolean;
  hasTranslation: boolean;
  onOpenSettings: () => void;
  onOpenExport: () => void;
  onToggleShare: () => void;
  onCopyShareLink?: () => void;
  onTogglePip: () => void;
  isSharing: boolean;
  shareUrl?: string | null;
  pipOpen: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRetry: () => void;
  onViewPlayback: () => void;
  onManualSummary: () => void;
  onInjectKeywords: (keywords: string[]) => Promise<void> | void;
}

const TAB_SEQUENCE: MobileTab[] = [
  'transcript',
  'translation',
  'summary',
  'chat',
  'keywords',
];

function getNextTab(current: MobileTab, hasTranslation: boolean, direction: 'left' | 'right') {
  const tabs = TAB_SEQUENCE.filter((tab) => hasTranslation || tab !== 'translation');
  const currentIndex = tabs.indexOf(current);
  if (currentIndex === -1) {
    return tabs[0] ?? 'transcript';
  }

  if (direction === 'left') {
    return tabs[Math.min(tabs.length - 1, currentIndex + 1)] ?? current;
  }

  return tabs[Math.max(0, currentIndex - 1)] ?? current;
}

export default function MobileSessionLayout({
  sessionId,
  sessionTitle,
  isEditingTitle,
  editingTitle,
  titleInputRef,
  onStartEditTitle,
  onConfirmTitle,
  onCancelTitleEdit,
  onEditTitleChange,
  recordingState,
  connectionState,
  connectionMeta,
  elapsed,
  backupMeta,
  serviceAvailable,
  hasPendingSave,
  hasTranslation,
  onOpenSettings,
  onOpenExport,
  onToggleShare,
  onCopyShareLink,
  onTogglePip,
  isSharing,
  shareUrl,
  pipOpen,
  onStart,
  onPause,
  onResume,
  onStop,
  onRetry,
  onViewPlayback,
  onManualSummary,
  onInjectKeywords,
}: MobileSessionLayoutProps) {
  const [activeTab, setActiveTab] = useState<MobileTab>('transcript');
  const keyboardHeight = useKeyboardHeight();
  const contentRef = useRef<HTMLDivElement>(null);

  useSwipeGesture(contentRef, {
    onSwipeLeft: () => setActiveTab((current) => getNextTab(current, hasTranslation, 'left')),
    onSwipeRight: () => setActiveTab((current) => getNextTab(current, hasTranslation, 'right')),
    threshold: 60,
  });

  const hideControlBar = keyboardHeight > 0 && activeTab === 'chat';
  const bottomOffset = useMemo(() => (hideControlBar ? 0 : 0), [hideControlBar]);

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-cream-50">
      <MobileSessionHeader
        title={sessionTitle}
        isEditing={isEditingTitle}
        editingTitle={editingTitle}
        titleInputRef={titleInputRef}
        onStartEdit={onStartEditTitle}
        onConfirmEdit={onConfirmTitle}
        onCancelEdit={onCancelTitleEdit}
        onEditChange={onEditTitleChange}
        recordingState={recordingState}
        connectionState={connectionState}
        connectionMeta={connectionMeta}
        elapsed={elapsed}
        onOpenSettings={onOpenSettings}
        onOpenExport={onOpenExport}
        onToggleShare={onToggleShare}
        onCopyShareLink={onCopyShareLink}
        onTogglePip={onTogglePip}
        isSharing={isSharing}
        shareUrl={shareUrl}
        pipOpen={pipOpen}
        serviceAvailable={serviceAvailable}
        backupMeta={backupMeta}
      />

      <div
        ref={contentRef}
        className="min-h-0 flex-1 overflow-hidden"
        data-session-id={sessionId}
      >
        {activeTab === 'transcript' ? (
          <TranscriptPanel
            className="h-full rounded-none border-0 shadow-none"
            contentClassName="px-4 py-4"
            showHeader={false}
            compact
          />
        ) : null}
        {activeTab === 'translation' && hasTranslation ? (
          <TranslationPanel
            className="h-full rounded-none border-0 shadow-none"
            contentClassName="px-4 py-4"
            showHeader={false}
          />
        ) : null}
        {activeTab === 'summary' ? (
          <div className="h-full bg-white">
            <SummaryTab onManualTrigger={onManualSummary} />
          </div>
        ) : null}
        {activeTab === 'chat' ? (
          <div className="h-full bg-white">
            <ChatTab onInjectKeywords={onInjectKeywords} inputSticky />
          </div>
        ) : null}
        {activeTab === 'keywords' ? (
          <div className="h-full bg-white">
            <KeywordTab onInjectKeywords={onInjectKeywords} />
          </div>
        ) : null}
      </div>

      <div style={{ bottom: bottomOffset }}>
        <MobileContentTabs
          activeTab={activeTab}
          onChange={setActiveTab}
          hasTranslation={hasTranslation}
        />
        {!hideControlBar ? (
          <MobileControlBar
            recordingState={recordingState}
            connectionState={connectionState}
            elapsed={elapsed}
            serviceAvailable={serviceAvailable}
            hasPendingSave={hasPendingSave}
            onStart={onStart}
            onPause={onPause}
            onResume={onResume}
            onStop={onStop}
            onRetry={onRetry}
            onViewPlayback={onViewPlayback}
          />
        ) : null}
      </div>
    </div>
  );
}
