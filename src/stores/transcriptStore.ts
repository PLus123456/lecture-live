'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  EMPTY_STREAMING_PREVIEW_TEXT,
  EMPTY_STREAMING_PREVIEW_TRANSLATION,
  combinePreviewText,
  normalizePreviewText,
  normalizePreviewTranslation,
} from '@/lib/transcriptPreview';
import type {
  TranscriptSegment,
  ConnectionState,
  RecordingState,
  StreamingPreviewText,
  StreamingPreviewTranslation,
} from '@/types/transcript';

export interface ConnectionMeta {
  region: string | null;       // 'us' | 'eu' | 'jp'
  wsUrl: string | null;
  latencyMs: number | null;    // WebSocket 连接建立 RTT
  connectedAt: number | null;  // timestamp
  transcriptionLatencyMs: number | null; // 实时出字延迟（语音→文字）
}

export interface BackupMeta {
  syncState: 'idle' | 'syncing' | 'synced' | 'pending' | 'error';
  localChunkCount: number;
  remoteChunkCount: number;
  updatedAt: number | null;
  lastError: string | null;
}

interface TranscriptStore {
  segments: TranscriptSegment[];
  currentPreview: string;
  currentPreviewTranslation: string;
  currentPreviewText: StreamingPreviewText;
  currentPreviewTranslationText: StreamingPreviewTranslation;
  connectionState: ConnectionState;
  connectionMeta: ConnectionMeta;
  backupMeta: BackupMeta;
  recordingState: RecordingState;
  totalDurationMs: number;
  recordingStartTime: number | null;
  pausedAt: number | null;
  totalPausedMs: number;
  currentSessionIndex: number;
  currentMicDeviceId: string | null;
  availableMics: MediaDeviceInfo[];
  // 全局实时 store 归属的会话 id。SPA 内单例不销毁，导航到别的会话时据此判定
  // segments/计时/recordingState 是否属于本会话，杜绝跨会话串数据（P0-3）。
  activeSessionId: string | null;

  addFinalSegment: (segment: TranscriptSegment) => void;
  updatePreview: (preview: string | StreamingPreviewText) => void;
  updatePreviewTranslation: (preview: string | StreamingPreviewTranslation) => void;
  setConnectionState: (state: ConnectionState) => void;
  setConnectionMeta: (meta: Partial<ConnectionMeta>) => void;
  setBackupMeta: (meta: Partial<BackupMeta>) => void;
  resetBackupMeta: () => void;
  setRecordingState: (state: RecordingState) => void;
  setRecordingStartTime: (time: number | null) => void;
  setPausedAt: (time: number | null) => void;
  accumulatePausedTime: () => void;
  updateDuration: (ms: number) => void;
  setCurrentSessionIndex: (index: number) => void;
  setCurrentMicDeviceId: (deviceId: string | null) => void;
  setAvailableMics: (mics: MediaDeviceInfo[]) => void;
  setActiveSessionId: (sessionId: string | null) => void;
  clearAll: () => void;
}

// 水合状态 — 用于确保 sessionStorage 数据读取完成后再做初始化决策
let _hydrated = false;
const _hydrationCallbacks: Array<() => void> = [];

export function waitForTranscriptHydration(): Promise<void> {
  if (_hydrated) return Promise.resolve();
  return new Promise((resolve) => {
    _hydrationCallbacks.push(resolve);
  });
}

export const useTranscriptStore = create<TranscriptStore>()(
  persist(
    (set) => ({
      segments: [],
      currentPreview: '',
      currentPreviewTranslation: '',
      currentPreviewText: EMPTY_STREAMING_PREVIEW_TEXT,
      currentPreviewTranslationText: EMPTY_STREAMING_PREVIEW_TRANSLATION,
      connectionState: 'disconnected',
      connectionMeta: { region: null, wsUrl: null, latencyMs: null, connectedAt: null, transcriptionLatencyMs: null },
      backupMeta: {
        syncState: 'idle',
        localChunkCount: 0,
        remoteChunkCount: 0,
        updatedAt: null,
        lastError: null,
      },
      recordingState: 'idle',
      totalDurationMs: 0,
      recordingStartTime: null,
      pausedAt: null,
      totalPausedMs: 0,
      currentSessionIndex: 0,
      currentMicDeviceId: null,
      availableMics: [],
      activeSessionId: null,

      addFinalSegment: (segment) =>
        set((state) => ({ segments: [...state.segments, segment] })),

      updatePreview: (preview) => {
        const normalized = normalizePreviewText(preview);
        set({
          currentPreviewText: normalized,
          currentPreview: combinePreviewText(normalized),
        });
      },

      updatePreviewTranslation: (preview) => {
        const normalized = normalizePreviewTranslation(preview);
        set({
          currentPreviewTranslationText: normalized,
          currentPreviewTranslation: combinePreviewText(normalized),
        });
      },

      setConnectionState: (connectionState) => set({ connectionState }),

      setConnectionMeta: (meta) =>
        set((state) => ({
          connectionMeta: { ...state.connectionMeta, ...meta },
        })),

      setBackupMeta: (meta) =>
        set((state) => ({
          backupMeta: { ...state.backupMeta, ...meta },
        })),

      resetBackupMeta: () =>
        set({
          backupMeta: {
            syncState: 'idle',
            localChunkCount: 0,
            remoteChunkCount: 0,
            updatedAt: null,
            lastError: null,
          },
        }),

      setRecordingState: (recordingState) => set({ recordingState }),

      setRecordingStartTime: (time) => set({ recordingStartTime: time }),

      setPausedAt: (time) => set({ pausedAt: time }),

      accumulatePausedTime: () =>
        set((state) => {
          if (!state.pausedAt) return state;
          return {
            totalPausedMs: state.totalPausedMs + (Date.now() - state.pausedAt),
            pausedAt: null,
          };
        }),

      updateDuration: (ms) => set({ totalDurationMs: ms }),

      setCurrentSessionIndex: (index) => set({ currentSessionIndex: index }),

      setCurrentMicDeviceId: (deviceId) => set({ currentMicDeviceId: deviceId }),

      setAvailableMics: (mics) => set({ availableMics: mics }),

      setActiveSessionId: (sessionId) => set({ activeSessionId: sessionId }),

      clearAll: () =>
        set({
          segments: [],
          currentPreview: '',
          currentPreviewTranslation: '',
          currentPreviewText: EMPTY_STREAMING_PREVIEW_TEXT,
          currentPreviewTranslationText: EMPTY_STREAMING_PREVIEW_TRANSLATION,
          connectionState: 'disconnected',
          connectionMeta: { region: null, wsUrl: null, latencyMs: null, connectedAt: null, transcriptionLatencyMs: null },
          backupMeta: {
            syncState: 'idle',
            localChunkCount: 0,
            remoteChunkCount: 0,
            updatedAt: null,
            lastError: null,
          },
          recordingState: 'idle',
          totalDurationMs: 0,
          recordingStartTime: null,
          pausedAt: null,
          totalPausedMs: 0,
          currentSessionIndex: 0,
          currentMicDeviceId: null,
          availableMics: [],
          activeSessionId: null,
        }),
    }),
    {
      name: 'lecture-live-transcript',
      storage: createJSONStorage(() => sessionStorage),
      // 只持久化可序列化的核心数据，不包含 MediaDeviceInfo 等不可序列化的对象
      partialize: (state) => ({
        segments: state.segments,
        currentPreview: state.currentPreview,
        currentPreviewTranslation: state.currentPreviewTranslation,
        currentPreviewText: state.currentPreviewText,
        currentPreviewTranslationText: state.currentPreviewTranslationText,
        recordingState: state.recordingState,
        recordingStartTime: state.recordingStartTime,
        pausedAt: state.pausedAt,
        totalPausedMs: state.totalPausedMs,
        totalDurationMs: state.totalDurationMs,
        currentSessionIndex: state.currentSessionIndex,
        activeSessionId: state.activeSessionId,
      }),
      onRehydrateStorage: () => () => {
        _hydrated = true;
        _hydrationCallbacks.forEach((cb) => cb());
        _hydrationCallbacks.length = 0;
      },
    }
  )
);
