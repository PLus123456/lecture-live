'use client';

import { clearAllAudioArchives } from '@/lib/audio/audioChunkStore';
import { teardownActiveRecordingArchivesForAccountBoundary } from '@/lib/audio/recordingArchiveRegistry';
import { revokeAllAccountObjectUrls } from '@/lib/accountObjectUrls';
import { useChatStore } from '@/stores/chatStore';
import { useConversationListStore } from '@/stores/conversationListStore';
import { useKeywordStore } from '@/stores/keywordStore';
import { useLiveShareStore } from '@/stores/liveShareStore';
import {
  SHARED_LINKS_STORAGE_KEY,
  useSharedLinksStore,
} from '@/stores/sharedLinksStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSummaryStore } from '@/stores/summaryStore';
import { useToastStore } from '@/stores/toastStore';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useTranslationStore } from '@/stores/translationStore';
import { uploadJobs } from '@/stores/uploadJobsStore';

export const ACCOUNT_BOUNDARY_CLEAR_EVENT =
  'lecture-live:account-boundary-clear';

const ACCOUNT_LOCAL_STORAGE_KEYS = [
  SHARED_LINKS_STORAGE_KEY,
  'lecture-live-upload-jobs',
] as const;

const ACCOUNT_SESSION_STORAGE_KEYS = [
  'lecture-live-transcript',
  'lecture-live-translations',
  'lecture-live-summary',
  'lecture-live-archive-mime',
] as const;

/** 清空本 origin 的 Cache Storage；HTTP cache 另由 auth 响应的 Clear-Site-Data 清理。 */
async function clearCacheStorage(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const names = await caches.keys();
  const deleted = await Promise.all(names.map((name) => caches.delete(name)));
  if (deleted.some((ok) => !ok)) {
    const remaining = new Set(await caches.keys());
    if (names.some((name) => remaining.has(name))) {
      throw new Error('Account cache cleanup could not be confirmed');
    }
  }
}

function clearPersistedAccountStorage() {
  try {
    for (const key of ACCOUNT_LOCAL_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // Safari 隐私模式 / 禁止 storage：内存状态仍已清。
  }

  try {
    const archiveSnapshotKeys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith('lecture-live-archive-state:')) {
        archiveSnapshotKeys.push(key);
      }
    }
    for (const key of ACCOUNT_SESSION_STORAGE_KEYS) {
      sessionStorage.removeItem(key);
    }
    for (const key of archiveSnapshotKeys) {
      sessionStorage.removeItem(key);
    }
  } catch {
    // 同上，尽力而为。
  }
}

/**
 * 唯一账号边界清理器。同步段先让旧主体数据从 UI/运行时消失并中止任务；异步段再清
 * IndexedDB 与 Cache Storage。调用方必须在建立新主体前 await，本函数自身不改 auth store，
 * 避免循环依赖并允许 logout / 401 / direct user switch 共用。
 */
export async function clearAccountBoundClientState(): Promise<void> {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(ACCOUNT_BOUNDARY_CLEAR_EVENT));
  }

  // invalidateForAccountBoundary runs synchronously before this promise first
  // yields. This closes the window where a final MediaRecorder dataavailable
  // callback could recreate data while the synchronous stores are being reset.
  const recordingTeardown =
    teardownActiveRecordingArchivesForAccountBoundary();

  useConversationListStore.getState().clear();
  useChatStore.getState().resetForAccountSwitch();
  useSharedLinksStore.getState().clearViewedLinks();
  useTranscriptStore.getState().clearAll();
  useTranslationStore.getState().clearAll();
  useSummaryStore.getState().clearAll();
  useKeywordStore.getState().clearAll();
  useLiveShareStore.getState().reset();
  uploadJobs.clearForAccountSwitch();
  useSettingsStore.getState().clearAccountBoundState();
  useToastStore.getState().clear();
  revokeAllAccountObjectUrls();
  clearPersistedAccountStorage();

  // Any chunk/session writes that started before invalidation must settle
  // before clearing IndexedDB. Running these concurrently would let the old
  // write commit after clearAllAudioArchives and resurrect the prior account.
  await recordingTeardown;

  const cleanup = await Promise.allSettled([
    clearAllAudioArchives(),
    clearCacheStorage(),
  ]);
  const failures = cleanup.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Account-bound persistent state cleanup failed'
    );
  }
}
