'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  TranscriptSegment,
  ConnectionState,
  RecordingState,
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

  addFinalSegment: (segment: TranscriptSegment) => void;
  updatePreview: (text: string) => void;
  updatePreviewTranslation: (text: string) => void;
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

      addFinalSegment: (segment) =>
        set((state) => ({ segments: [...state.segments, segment] })),

      updatePreview: (text) => set({ currentPreview: text }),

      updatePreviewTranslation: (text) => set({ currentPreviewTranslation: text }),

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

      clearAll: () =>
        set({
          segments: [],
          currentPreview: '',
          currentPreviewTranslation: '',
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
        recordingState: state.recordingState,
        recordingStartTime: state.recordingStartTime,
        pausedAt: state.pausedAt,
        totalPausedMs: state.totalPausedMs,
        totalDurationMs: state.totalDurationMs,
        currentSessionIndex: state.currentSessionIndex,
      }),
      onRehydrateStorage: () => () => {
        _hydrated = true;
        _hydrationCallbacks.forEach((cb) => cb());
        _hydrationCallbacks.length = 0;
      },
    }
  )
);
