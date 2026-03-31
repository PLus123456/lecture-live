'use client';

import { useCallback, useEffect, useRef } from 'react';
import { combinePreviewText } from '@/lib/transcriptPreview';
import { useTranscriptStore, type BackupMeta } from '@/stores/transcriptStore';
import { useTranslationStore } from '@/stores/translationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAuthStore } from '@/stores/authStore';
import { TokenProcessor } from '@/lib/soniox/tokenProcessor';
import { buildSonioxConfig, startSonioxRecording } from '@/lib/soniox/client';
import {
  getAllAudioChunks,
  getArchiveMimeType,
  getAudioChunkEntries,
  hasAudioChunks,
} from '@/lib/audio/audioChunkStore';
import { RecordingArchiveManager } from '@/lib/audio/recordingArchiveManager';
import {
  DEFAULT_AUDIO_ACTIVITY_LEVEL_THRESHOLD,
  DEFAULT_IDLE_TIMEOUT_MS,
} from '@/lib/billing';
import type { RealtimeToken } from '@/types/soniox';

type RecordingHandle = {
  stop?: () => Promise<void> | void;
  pause?: () => void;
  resume?: () => void;
};

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1500;

interface UseSonioxOptions {
  idleTimeoutMs?: number;
  audioActivityThreshold?: number;
  onAutoPause?: (reason: 'idle' | 'disconnect') => void;
  onAutoResume?: (reason: 'disconnect') => void;
}

export function useSoniox(
  sessionId?: string,
  options: UseSonioxOptions = {}
) {
  const recordingRef = useRef<{ recording: RecordingHandle; client: unknown } | null>(
    null
  );
  const archiveManagerRef = useRef<RecordingArchiveManager | null>(null);
  const processorRef = useRef<TokenProcessor | null>(null);
  const runIdRef = useRef(0);
  const overallStartTimeRef = useRef<number | null>(null);
  const lastAudioBlobRef = useRef<Blob | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteDraftSeqsRef = useRef<Set<number>>(new Set());
  const syncDraftPromiseRef = useRef<Promise<boolean> | null>(null);
  const lastAudioActivityAtRef = useRef<number | null>(null);
  const autoPauseReasonRef = useRef<'idle' | 'disconnect' | null>(null);
  const shouldReconnectRef = useRef(false);
  const finalizeOnUnloadSentRef = useRef(false);

  // 出字延迟追踪
  const sessionStartWallClockRef = useRef<number | null>(null);
  const latencyEmaRef = useRef<number | null>(null);
  const lastLatencyFlushRef = useRef(0);
  const LATENCY_EMA_ALPHA = 0.3;
  const LATENCY_FLUSH_INTERVAL = 2000; // 每 2 秒更新一次 store

  const addFinalSegment = useTranscriptStore((s) => s.addFinalSegment);
  const updatePreview = useTranscriptStore((s) => s.updatePreview);
  const updatePreviewTranslation = useTranscriptStore((s) => s.updatePreviewTranslation);
  const setConnectionState = useTranscriptStore((s) => s.setConnectionState);
  const setConnectionMeta = useTranscriptStore((s) => s.setConnectionMeta);
  const setBackupMeta = useTranscriptStore((s) => s.setBackupMeta);
  const resetBackupMeta = useTranscriptStore((s) => s.resetBackupMeta);
  const setRecordingState = useTranscriptStore((s) => s.setRecordingState);
  const setRecordingStartTime = useTranscriptStore((s) => s.setRecordingStartTime);
  const setCurrentMicDeviceId = useTranscriptStore((s) => s.setCurrentMicDeviceId);
  const setTranslation = useTranslationStore((s) => s.setTranslation);
  const setTranslationEntry = useTranslationStore((s) => s.setTranslationEntry);
  const token = useAuthStore((s) => s.token);
  const recordingState = useTranscriptStore((s) => s.recordingState);
  const setPausedAt = useTranscriptStore((s) => s.setPausedAt);
  const accumulatePausedTime = useTranscriptStore((s) => s.accumulatePausedTime);
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const audioActivityThreshold =
    options.audioActivityThreshold ?? DEFAULT_AUDIO_ACTIVITY_LEVEL_THRESHOLD;
  const onAutoPause = options.onAutoPause;
  const onAutoResume = options.onAutoResume;

  const markAudioActivity = useCallback(() => {
    lastAudioActivityAtRef.current = Date.now();
  }, []);

  const publishBackupMeta = useCallback(
    (meta: {
      localChunkCount: number;
      remoteChunkCount: number;
      syncState?: BackupMeta['syncState'];
      lastError?: string | null;
    }) => {
      const syncState =
        meta.syncState ??
        (meta.localChunkCount === 0
          ? 'idle'
          : meta.remoteChunkCount >= meta.localChunkCount
            ? 'synced'
            : 'pending');

      setBackupMeta({
        syncState,
        localChunkCount: meta.localChunkCount,
        remoteChunkCount: meta.remoteChunkCount,
        updatedAt: Date.now(),
        lastError: meta.lastError ?? null,
      });
    },
    [setBackupMeta]
  );

  const uploadDraftChunk = useCallback(
    async (seq: number, blob: Blob, mimeType: string) => {
      if (!sessionId || !token) {
        return false;
      }

      const localChunkCount = Math.max(
        useTranscriptStore.getState().backupMeta.localChunkCount,
        seq + 1
      );

      if (remoteDraftSeqsRef.current.has(seq)) {
        publishBackupMeta({
          localChunkCount,
          remoteChunkCount: remoteDraftSeqsRef.current.size,
          syncState:
            remoteDraftSeqsRef.current.size >= localChunkCount ? 'synced' : 'pending',
        });
        return true;
      }

      publishBackupMeta({
        localChunkCount,
        remoteChunkCount: remoteDraftSeqsRef.current.size,
        syncState: 'syncing',
      });

      const formData = new FormData();
      formData.append('file', blob, `${sessionId}-${seq}.chunk`);
      formData.append('seq', String(seq));
      formData.append('mimeType', mimeType);

      try {
        const response = await fetch(
          `/api/sessions/${sessionId}/audio/draft/chunks`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            keepalive: true,
            body: formData,
          }
        );

        if (!response.ok) {
          publishBackupMeta({
            localChunkCount,
            remoteChunkCount: remoteDraftSeqsRef.current.size,
            syncState: 'pending',
            lastError: 'Some audio chunks are still waiting to upload',
          });
          return false;
        }

        remoteDraftSeqsRef.current.add(seq);
        publishBackupMeta({
          localChunkCount,
          remoteChunkCount: remoteDraftSeqsRef.current.size,
        });

        return true;
      } catch {
        publishBackupMeta({
          localChunkCount,
          remoteChunkCount: remoteDraftSeqsRef.current.size,
          syncState: 'pending',
          lastError: 'Backup upload paused until the connection returns',
        });
        return false;
      }
    },
    [publishBackupMeta, sessionId, token]
  );

  const syncRemoteDraft = useCallback(async () => {
    if (syncDraftPromiseRef.current) {
      return syncDraftPromiseRef.current;
    }

    const syncPromise = (async () => {
      if (!sessionId || !token) {
        return false;
      }

      let localChunkCount = 0;
      try {
        const localEntries = await getAudioChunkEntries(sessionId);
        localChunkCount = localEntries.length;
        if (localEntries.length === 0) {
          remoteDraftSeqsRef.current = new Set();
          publishBackupMeta({
            localChunkCount: 0,
            remoteChunkCount: 0,
            syncState: 'idle',
          });
          return false;
        }

        publishBackupMeta({
          localChunkCount,
          remoteChunkCount: remoteDraftSeqsRef.current.size,
          syncState: 'syncing',
        });

        let remoteSeqs = new Set<number>();
        try {
          const response = await fetch(`/api/sessions/${sessionId}/audio/draft`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (response.ok) {
            const data = (await response.json()) as { seqs?: number[] };
            remoteSeqs = new Set(
              Array.isArray(data.seqs) ? data.seqs.filter(Number.isInteger) : []
            );
          }
        } catch {
          // Best effort: fall through and try direct chunk uploads.
        }

        remoteDraftSeqsRef.current = remoteSeqs;
        publishBackupMeta({
          localChunkCount,
          remoteChunkCount: remoteSeqs.size,
          syncState: remoteSeqs.size >= localChunkCount ? 'synced' : 'syncing',
        });

        const mimeType = await getArchiveMimeType(sessionId);
        let hadFailures = false;

        for (const entry of localEntries) {
          if (remoteDraftSeqsRef.current.has(entry.seq)) {
            continue;
          }

          const uploaded = await uploadDraftChunk(entry.seq, entry.blob, mimeType);
          if (!uploaded) {
            hadFailures = true;
          }
        }

        const remoteChunkCount = remoteDraftSeqsRef.current.size;
        const synced = !hadFailures && remoteChunkCount >= localChunkCount;

        publishBackupMeta({
          localChunkCount,
          remoteChunkCount,
          syncState: synced ? 'synced' : 'pending',
          lastError: synced ? null : 'Some audio chunks are still waiting to upload',
        });

        return synced;
      } catch (error) {
        publishBackupMeta({
          localChunkCount,
          remoteChunkCount: remoteDraftSeqsRef.current.size,
          syncState: 'error',
          lastError:
            error instanceof Error
              ? error.message
              : 'Failed to inspect local backup state',
        });
        return false;
      }
    })();

    syncDraftPromiseRef.current = syncPromise;
    try {
      return await syncPromise;
    } finally {
      if (syncDraftPromiseRef.current === syncPromise) {
        syncDraftPromiseRef.current = null;
      }
    }
  }, [publishBackupMeta, sessionId, token, uploadDraftChunk]);

  const finalizeRemoteDraft = useCallback(async () => {
    if (!sessionId || !token) {
      return false;
    }

    let localChunkCount = useTranscriptStore.getState().backupMeta.localChunkCount;
    try {
      localChunkCount = sessionId
        ? (await getAudioChunkEntries(sessionId)).length
        : 0;
    } catch {
      // Fall back to the latest known local count so stop can still continue.
    }

    publishBackupMeta({
      localChunkCount,
      remoteChunkCount: remoteDraftSeqsRef.current.size,
      syncState: 'syncing',
    });

    await syncRemoteDraft();

    try {
      const response = await fetch(
        `/api/sessions/${sessionId}/audio/draft/finalize`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!response.ok) {
        publishBackupMeta({
          localChunkCount,
          remoteChunkCount: remoteDraftSeqsRef.current.size,
          syncState: 'pending',
          lastError: 'Failed to finalize server backup',
        });
        return false;
      }

      publishBackupMeta({
        localChunkCount,
        remoteChunkCount: localChunkCount,
        syncState: localChunkCount > 0 ? 'synced' : 'idle',
      });
      return true;
    } catch (error) {
      publishBackupMeta({
        localChunkCount,
        remoteChunkCount: remoteDraftSeqsRef.current.size,
        syncState: 'pending',
        lastError:
          error instanceof Error
            ? error.message
            : 'Failed to finalize server backup',
      });
      return false;
    }
  }, [publishBackupMeta, sessionId, syncRemoteDraft, token]);

  const sendFinalizeBeacon = useCallback(() => {
    if (!sessionId || finalizeOnUnloadSentRef.current) {
      return false;
    }

    const currentRecordingState = useTranscriptStore.getState().recordingState;
    if (
      currentRecordingState !== 'recording' &&
      currentRecordingState !== 'paused'
    ) {
      return false;
    }

    finalizeOnUnloadSentRef.current = true;
    const url = `/api/sessions/${sessionId}/finalize?source=unload`;
    const payload = JSON.stringify({});

    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const didQueue = navigator.sendBeacon(
        url,
        new Blob([payload], { type: 'application/json' })
      );
      if (didQueue) {
        return true;
      }
    }

    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: payload,
    }).catch(() => undefined);

    return false;
  }, [sessionId]);

  const canRecoverLocally = useCallback(async () => {
    if (archiveManagerRef.current?.hasLiveCapture()) {
      return true;
    }
    if (lastAudioBlobRef.current) {
      return true;
    }
    if (!sessionId) {
      return false;
    }
    try {
      return await hasAudioChunks(sessionId);
    } catch {
      return false;
    }
  }, [sessionId]);

  const ensureProcessor = useCallback(() => {
    if (processorRef.current) {
      return processorRef.current;
    }

    const processor = new TokenProcessor({
      onSegmentFinalized: (segment) => {
        addFinalSegment(segment);
      },
      onPreviewUpdate: (preview) => {
        updatePreview(preview);
      },
      onTranslationToken: (text, segmentId, meta) => {
        setTranslation(segmentId, text, {
          state: meta?.state,
          sourceLanguage: meta?.sourceLanguage,
        });
      },
      onPreviewTranslationUpdate: (preview) => {
        updatePreviewTranslation(preview);
      },
    });

    // 设置目标语言，用于同语言 passthrough
    const { targetLang } = useSettingsStore.getState();
    processor.setTargetLang(targetLang);

    processorRef.current = processor;
    return processor;
  }, [
    addFinalSegment,
    setTranslation,
    updatePreview,
    updatePreviewTranslation,
  ]);

  // 根据窗口高度和用户设置动态计算段落截断阈值
  const segmentSplitRatio = useSettingsStore((s) => s.segmentSplitRatio);
  useEffect(() => {
    const LINE_HEIGHT = 23;   // text-sm + leading-relaxed ≈ 23px
    const CHARS_PER_LINE = 35; // 中英混排平均每行字符数

    const updateMaxChars = () => {
      if (segmentSplitRatio <= 0) {
        processorRef.current?.setMaxSegmentChars(0);
        return;
      }
      const maxLines = Math.floor((window.innerHeight * segmentSplitRatio) / LINE_HEIGHT);
      const maxChars = Math.max(maxLines * CHARS_PER_LINE, 80);
      processorRef.current?.setMaxSegmentChars(maxChars);
    };

    updateMaxChars();
    window.addEventListener('resize', updateMaxChars);
    return () => window.removeEventListener('resize', updateMaxChars);
  }, [segmentSplitRatio]);

  /**
   * 处理 onPartialResult 中的出字延迟计算。
   * 原理：token.end_ms 是音频流中该词结束的时间（相对于 Soniox 会话开始），
   * sessionStartWallClock 是 Soniox 会话开始的 wall clock，
   * 差值即为从说话到文字到达浏览器的真实延迟。
   */
  const updateTranscriptionLatency = useCallback(
    (tokens: RealtimeToken[]) => {
      const sessionStart = sessionStartWallClockRef.current;
      if (!sessionStart) return;

      // 找到最后一个 final token 的 end_ms
      let lastEndMs = -1;
      for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i];
        if (
          t.is_final &&
          t.translation_status !== 'translation' &&
          typeof t.end_ms === 'number' &&
          t.end_ms > 0
        ) {
          lastEndMs = t.end_ms;
          break;
        }
      }
      if (lastEndMs < 0) return;

      const now = Date.now();
      const latency = now - (sessionStart + lastEndMs);
      if (latency < 0) return; // 时钟偏移，忽略

      // EMA 平滑
      if (latencyEmaRef.current == null) {
        latencyEmaRef.current = latency;
      } else {
        latencyEmaRef.current =
          LATENCY_EMA_ALPHA * latency + (1 - LATENCY_EMA_ALPHA) * latencyEmaRef.current;
      }

      // 节流写入 store
      if (now - lastLatencyFlushRef.current >= LATENCY_FLUSH_INTERVAL) {
        lastLatencyFlushRef.current = now;
        setConnectionMeta({
          transcriptionLatencyMs: Math.round(latencyEmaRef.current),
        });
      }
    },
    [setConnectionMeta]
  );

  const pauseForInterruption = useCallback(
    async (reason: 'idle' | 'disconnect') => {
      const storeState = useTranscriptStore.getState();
      if (storeState.recordingState !== 'recording') {
        return;
      }

      if (reason === 'disconnect') {
        shouldReconnectRef.current = true;
      } else {
        shouldReconnectRef.current = false;
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        reconnectAttemptsRef.current = 0;
      }

      const current = recordingRef.current;
      recordingRef.current = null;
      runIdRef.current += 1;

      try {
        await current?.recording.stop?.();
      } catch (error) {
        console.error(`Error stopping recording during ${reason} pause:`, error);
      }

      try {
        await archiveManagerRef.current?.pause();
      } catch (error) {
        console.error(`Error pausing archive during ${reason} pause:`, error);
      }

      processorRef.current?.onEndpoint();
      setPausedAt(Date.now());
      setRecordingState('paused');
      setConnectionState(reason === 'disconnect' ? 'reconnecting' : 'disconnected');
      autoPauseReasonRef.current = reason;
      onAutoPause?.(reason);
    },
    [onAutoPause, setConnectionState, setPausedAt, setRecordingState]
  );

  // 内部重连函数 — 断网后自动尝试重新建立 Soniox 连接
  const attemptReconnect = useCallback(
    async () => {
      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        console.error('Max reconnect attempts reached, giving up');
        shouldReconnectRef.current = false;
        setConnectionState('error');
        if (!(await canRecoverLocally())) {
          setRecordingState('paused');
        }
        reconnectAttemptsRef.current = 0;
        return;
      }

      reconnectAttemptsRef.current += 1;
      const attempt = reconnectAttemptsRef.current;
      const delay = RECONNECT_BASE_DELAY_MS * Math.pow(1.5, attempt - 1);
      console.log(`Reconnecting attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay)}ms...`);

      setConnectionState('reconnecting');

      reconnectTimerRef.current = setTimeout(async () => {
        const storeState = useTranscriptStore.getState();
        if (
          storeState.recordingState === 'idle' ||
          storeState.recordingState === 'stopped' ||
          storeState.recordingState === 'finalizing' ||
          (!shouldReconnectRef.current && storeState.recordingState !== 'recording')
        ) {
          shouldReconnectRef.current = false;
          reconnectAttemptsRef.current = 0;
          return;
        }

        const offsetMs = overallStartTimeRef.current
          ? Date.now() - overallStartTimeRef.current
          : 0;

        processorRef.current?.onEndpoint();
        processorRef.current?.startNewSession(offsetMs);

        try {
          const settings = useSettingsStore.getState();
          const currentToken = useAuthStore.getState().token;
          if (!currentToken) {
            setConnectionState('error');
            return;
          }

          const config = settings.getSessionConfig(sessionId);
          const sonioxConfig = buildSonioxConfig(config);
          const sourceType = settings.audioSource;
          const selectedMicDeviceId = settings.preferredMicDeviceId;
          const archiveManager =
            archiveManagerRef.current && sessionId
              ? archiveManagerRef.current
              : sessionId
                ? new RecordingArchiveManager(sessionId)
                : null;

          if (!archiveManager || !sessionId) {
            throw new Error('Missing session ID for recording recovery');
          }

          archiveManagerRef.current = archiveManager;
          archiveManager.setChunkStoredHandler(({ seq, blob, mimeType }) => {
            return uploadDraftChunk(seq, blob, mimeType);
          });
          await archiveManager.ensureArchive({
            sourceType,
            deviceId: sourceType === 'mic' ? selectedMicDeviceId : undefined,
            preserveData: true,
          });
          const managedStream = await archiveManager.getSenderStream();
          void syncRemoteDraft();

          const runId = runIdRef.current + 1;
          runIdRef.current = runId;
          const connectStartMs = performance.now();

          const result = await startSonioxRecording(
            sonioxConfig,
            currentToken,
            {
              onPartialResult: (tokens) => {
                if (runId !== runIdRef.current) return;
                if (tokens.length > 0) {
                  markAudioActivity();
                }
                processorRef.current?.processTokens(tokens as RealtimeToken[]);
                updateTranscriptionLatency(tokens as RealtimeToken[]);
              },
              onEndpoint: () => {
                if (runId !== runIdRef.current) return;
                processorRef.current?.onEndpoint();
              },
              onError: (error) => {
                if (runId !== runIdRef.current) return;
                console.error('Soniox error (reconnect):', error);
                void pauseForInterruption('disconnect');
                // 继续尝试重连
                attemptReconnect();
              },
              onConnectionChange: (state) => {
                if (runId !== runIdRef.current) return;
                setConnectionState(state as 'connecting' | 'connected' | 'error');
                if (state === 'connected') {
                  reconnectAttemptsRef.current = 0;
                  const latencyMs = Math.round(performance.now() - connectStartMs);
                  sessionStartWallClockRef.current = Date.now();
                  latencyEmaRef.current = null;
                  setConnectionMeta({ latencyMs, connectedAt: Date.now(), transcriptionLatencyMs: null });
                  void archiveManagerRef.current?.resume().catch((error) => {
                    console.error('Failed to resume archive after reconnect:', error);
                  });
                  accumulatePausedTime();
                  setRecordingState('recording');
                  autoPauseReasonRef.current = null;
                  shouldReconnectRef.current = false;
                  markAudioActivity();
                  onAutoResume?.('disconnect');
                }
              },
            },
            {
              sourceType,
              deviceId: sourceType === 'mic' ? selectedMicDeviceId : undefined,
              managedStream,
              regionPreference: settings.sonioxRegionPreference,
              clientReferenceId: sessionId,
              onAudioLevel: (level) => {
                if (level >= audioActivityThreshold) {
                  markAudioActivity();
                }
              },
            }
          );

          if (runId !== runIdRef.current) {
            try { await result.recording.stop?.(); } catch { /* silent */ }
            return;
          }

          if (result.temporaryKey) {
            setConnectionMeta({
              region: result.temporaryKey.region,
              wsUrl: result.temporaryKey.ws_base_url,
            });
          }

          recordingRef.current = result as {
            recording: RecordingHandle;
            client: unknown;
          };
        } catch (error) {
          console.error('Reconnect attempt failed:', error);
          // 继续尝试
          attemptReconnect();
        }
      }, delay);
    },
    [
      canRecoverLocally,
      accumulatePausedTime,
      audioActivityThreshold,
      markAudioActivity,
      onAutoResume,
      pauseForInterruption,
      sessionId,
      setConnectionMeta,
      setConnectionState,
      setRecordingState,
      syncRemoteDraft,
      updateTranscriptionLatency,
      uploadDraftChunk,
    ]
  );

  const startNewRecording = useCallback(
    async (startOptions?: {
      preserveStartTime?: boolean;
      reuseProcessor?: boolean;
      overrideMicDeviceId?: string | null;
      preservePauseStateUntilConnected?: boolean;
    }) => {
      if (!token) {
        setConnectionState('error');
        setRecordingState('idle');
        return;
      }

      const previousRecordingState = useTranscriptStore.getState().recordingState;
      const settings = useSettingsStore.getState();
      const config = settings.getSessionConfig(sessionId);
      const sonioxConfig = buildSonioxConfig(config);
      const sourceType = settings.audioSource;
      const selectedMicDeviceId =
        startOptions?.overrideMicDeviceId ?? settings.preferredMicDeviceId;

      const processor =
        startOptions?.reuseProcessor && processorRef.current
          ? processorRef.current
          : ensureProcessor();

      const startedAt =
        startOptions?.preserveStartTime && overallStartTimeRef.current
          ? overallStartTimeRef.current
          : Date.now();
      const keepPausedUntilConnected =
        startOptions?.preservePauseStateUntilConnected &&
        previousRecordingState === 'paused';

      overallStartTimeRef.current = startedAt;
      setRecordingStartTime(startedAt);
      setRecordingState(keepPausedUntilConnected ? 'paused' : 'recording');
      setCurrentMicDeviceId(sourceType === 'mic' ? selectedMicDeviceId ?? null : null);
      reconnectAttemptsRef.current = 0;
      if (!keepPausedUntilConnected) {
        autoPauseReasonRef.current = null;
      }
      shouldReconnectRef.current = false;
      markAudioActivity();

      if (!startOptions?.preserveStartTime) {
        remoteDraftSeqsRef.current = new Set();
        resetBackupMeta();
      }

      const runId = runIdRef.current + 1;
      runIdRef.current = runId;

      // Consume pre-acquired system audio stream if available
      const preAcquiredStream =
          sourceType === 'system'
            ? useSettingsStore.getState().consumePendingSystemStream() ?? undefined
            : undefined;

      try {
        if (!sessionId) {
          throw new Error('Missing session ID for recording');
        }

        const archiveManager =
          archiveManagerRef.current ?? new RecordingArchiveManager(sessionId);
        archiveManagerRef.current = archiveManager;
        archiveManager.setChunkStoredHandler(({ seq, blob, mimeType }) => {
          return uploadDraftChunk(seq, blob, mimeType);
        });
        await archiveManager.ensureArchive({
          sourceType,
          deviceId: sourceType === 'mic' ? selectedMicDeviceId : undefined,
          preAcquiredStream,
          preserveData: startOptions?.preserveStartTime,
          startedAt,
        });
        const localChunkCount = (await getAudioChunkEntries(sessionId)).length;
        publishBackupMeta({
          localChunkCount,
          remoteChunkCount: remoteDraftSeqsRef.current.size,
          syncState:
            localChunkCount === 0
              ? 'idle'
              : remoteDraftSeqsRef.current.size >= localChunkCount
                ? 'synced'
                : 'pending',
        });
        const managedStream = await archiveManager.getSenderStream();
        if (startOptions?.preserveStartTime || localChunkCount > 0) {
          void syncRemoteDraft();
        }

        const connectStartMs = performance.now();

        const result = await startSonioxRecording(
          sonioxConfig,
          token,
          {
            onPartialResult: (tokens) => {
              if (runId !== runIdRef.current) {
                return;
              }
              if (tokens.length > 0) {
                markAudioActivity();
              }
              processor.processTokens(tokens as RealtimeToken[]);
              updateTranscriptionLatency(tokens as RealtimeToken[]);
            },
            onEndpoint: () => {
              if (runId !== runIdRef.current) {
                return;
              }
              processor.onEndpoint();
            },
            onError: (error) => {
              if (runId !== runIdRef.current) {
                return;
              }
              console.error('Soniox error:', error);
              void pauseForInterruption('disconnect');
              attemptReconnect();
            },
            onConnectionChange: (state) => {
              if (runId !== runIdRef.current) {
                return;
              }
              setConnectionState(state as 'connecting' | 'connected' | 'error');
              if (state === 'connected') {
                reconnectAttemptsRef.current = 0;
                const latencyMs = Math.round(performance.now() - connectStartMs);
                sessionStartWallClockRef.current = Date.now();
                latencyEmaRef.current = null;
                setConnectionMeta({
                  latencyMs,
                  connectedAt: Date.now(),
                  transcriptionLatencyMs: null,
                });
                if (keepPausedUntilConnected) {
                  void archiveManagerRef.current?.resume().catch((error) => {
                    console.error('Failed to resume archive after reconnect:', error);
                  });
                  accumulatePausedTime();
                  setRecordingState('recording');
                  if (autoPauseReasonRef.current === 'disconnect') {
                    onAutoResume?.('disconnect');
                  }
                  autoPauseReasonRef.current = null;
                  markAudioActivity();
                }
              }
            },
          },
          {
            sourceType,
            deviceId: sourceType === 'mic' ? selectedMicDeviceId : undefined,
            managedStream,
            regionPreference: settings.sonioxRegionPreference,
            clientReferenceId: sessionId,
            onAudioLevel: (level) => {
              if (level >= audioActivityThreshold) {
                markAudioActivity();
              }
            },
          }
        );

        // Store region and wsUrl from the temporary key response
        if (result.temporaryKey) {
          setConnectionMeta({
            region: result.temporaryKey.region,
            wsUrl: result.temporaryKey.ws_base_url,
          });
        }

        if (runId !== runIdRef.current) {
          try {
            await result.recording.stop?.();
          } catch (error) {
            console.error('Error stopping stale recording:', error);
          }
          return;
        }

        recordingRef.current = result as { recording: RecordingHandle; client: unknown };
      } catch (error) {
        if (runId !== runIdRef.current) {
          return;
        }

        console.error('Failed to start recording:', error);
        const recoverable = await canRecoverLocally();
        if (!startOptions?.reuseProcessor && !recoverable) {
          processorRef.current = null;
        }
        setConnectionState('error');
        if (!recoverable) {
          setRecordingState('idle');
          return;
        }
        setRecordingState(previousRecordingState === 'paused' ? 'paused' : 'recording');
      }
    },
    [
      accumulatePausedTime,
      audioActivityThreshold,
      canRecoverLocally,
      ensureProcessor,
      markAudioActivity,
      onAutoResume,
      pauseForInterruption,
      setConnectionState,
      setCurrentMicDeviceId,
      setConnectionMeta,
      publishBackupMeta,
      resetBackupMeta,
      setRecordingStartTime,
      setRecordingState,
      syncRemoteDraft,
      updateTranscriptionLatency,
      token,
      sessionId,
      attemptReconnect,
      uploadDraftChunk,
    ]
  );

  useEffect(() => {
    remoteDraftSeqsRef.current = new Set();
    resetBackupMeta();

    if (!sessionId) {
      return;
    }

    let cancelled = false;
    void getAudioChunkEntries(sessionId)
      .then((entries) => {
        if (cancelled) {
          return;
        }

        const remoteChunkCount = remoteDraftSeqsRef.current.size;
        publishBackupMeta({
          localChunkCount: entries.length,
          remoteChunkCount,
          syncState:
            entries.length === 0
              ? 'idle'
              : remoteChunkCount >= entries.length
                ? 'synced'
                : 'pending',
          lastError:
            entries.length > 0 && remoteChunkCount < entries.length
              ? 'Audio is safe locally and waiting to sync'
              : null,
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        resetBackupMeta();
      });

    return () => {
      cancelled = true;
    };
  }, [publishBackupMeta, resetBackupMeta, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    const handleOnline = () => {
      const { recordingState: currentRecordingState } = useTranscriptStore.getState();
      if (
        currentRecordingState === 'recording' ||
        currentRecordingState === 'paused' ||
        currentRecordingState === 'finalizing'
      ) {
        void syncRemoteDraft();
      }
    };

    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [sessionId, syncRemoteDraft]);

  useEffect(() => {
    if (recordingState !== 'recording') {
      return;
    }

    const interval = window.setInterval(() => {
      if (useTranscriptStore.getState().recordingState !== 'recording') {
        return;
      }

      const lastAudioActivityAt = lastAudioActivityAtRef.current;
      if (!lastAudioActivityAt) {
        return;
      }

      if (Date.now() - lastAudioActivityAt >= idleTimeoutMs) {
        void pauseForInterruption('idle');
      }
    }, Math.min(idleTimeoutMs, 15_000));

    return () => window.clearInterval(interval);
  }, [idleTimeoutMs, pauseForInterruption, recordingState]);

  useEffect(() => {
    if (recordingState === 'recording' || recordingState === 'paused') {
      finalizeOnUnloadSentRef.current = false;
    }
  }, [recordingState]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        archiveManagerRef.current?.checkpoint();
        void syncRemoteDraft();
      }
    };

    const handleBeforeUnload = () => {
      archiveManagerRef.current?.flushForPageUnload();
      void syncRemoteDraft();
      // 不在 unload 时 finalize：刷新页面也会触发 beforeunload，
      // 此时 finalize 会导致会话变为 COMPLETED，刷新后无法恢复录制。
      // 用户主动停止走 handleStopWithFinalization；
      // 真正关闭标签页的孤儿会话由 billingMaintenance 的 reclaimStaleSessions 兜底。
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
    };
  }, [sendFinalizeBeacon, syncRemoteDraft]);

  const start = useCallback(async () => {
    if (recordingRef.current && recordingState === 'paused') {
      autoPauseReasonRef.current = null;
      shouldReconnectRef.current = false;
      recordingRef.current.recording.resume?.();
      await archiveManagerRef.current?.resume();
      accumulatePausedTime();
      setRecordingState('recording');
      setConnectionState('connected');
      markAudioActivity();
      return;
    }

    if (recordingRef.current) {
      return;
    }

    await startNewRecording({
      preserveStartTime:
        recordingState === 'recording' || recordingState === 'paused',
      reuseProcessor:
        recordingState === 'recording' || recordingState === 'paused',
      preservePauseStateUntilConnected: recordingState === 'paused',
    });
  }, [
    accumulatePausedTime,
    markAudioActivity,
    recordingState,
    setConnectionState,
    setRecordingState,
    startNewRecording,
  ]);

  const stop = useCallback(async () => {
    // 取消任何正在进行的重连
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
    shouldReconnectRef.current = false;
    autoPauseReasonRef.current = null;
    lastAudioActivityAtRef.current = null;

    // 递增 runId 使所有在途的录音回调全部失效
    runIdRef.current += 1;

    const current = recordingRef.current;
    const activeRecording = current?.recording;
    const archiveManager = archiveManagerRef.current;
    recordingRef.current = null;

    // v2.1: transition through FINALIZING before STOPPED
    setRecordingState('finalizing');
    setConnectionState('disconnected');

    try {
      await activeRecording?.stop?.();
    } catch (error) {
      console.error('Error stopping recording:', error);
    }

    try {
      await archiveManager?.stop();
    } catch (error) {
      console.error('Error stopping archive recorder:', error);
    }

    // Collect archived audio blob after the archive recorder fully flushes.
    try {
      let archivedBlob = await archiveManager?.buildBlob();
      if (!archivedBlob && sessionId) {
        const allChunks = await getAllAudioChunks(sessionId);
        if (allChunks.length > 0) {
          const mimeType = await getArchiveMimeType(sessionId);
          archivedBlob = new Blob(allChunks, { type: mimeType });
        }
      }
      if (archivedBlob) {
        lastAudioBlobRef.current = archivedBlob;
      }
    } catch {
      // Best-effort: keep the last successfully built blob if IndexedDB read fails.
    }

    // Finalize any pending tokens
    processorRef.current?.onEndpoint();
    processorRef.current?.reset();
    processorRef.current = null;
    overallStartTimeRef.current = null;
    setRecordingStartTime(null);

    setRecordingState('stopped');
  }, [sessionId, setConnectionState, setRecordingStartTime, setRecordingState]);

  const pause = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
    shouldReconnectRef.current = false;
    autoPauseReasonRef.current = null;
    recordingRef.current?.recording.pause?.();
    void archiveManagerRef.current?.pause();
    processorRef.current?.onEndpoint();
    setPausedAt(Date.now());
    setRecordingState('paused');
  }, [setPausedAt, setRecordingState]);

  const switchMicrophone = useCallback(
    async (deviceId: string) => {
      const settings = useSettingsStore.getState();
      settings.setPreferredMicDeviceId(deviceId);
      setCurrentMicDeviceId(deviceId);

      if (settings.audioSource !== 'mic' || !recordingRef.current) {
        return;
      }

      const activeRecording = recordingRef.current.recording;
      const offsetMs = overallStartTimeRef.current
        ? Date.now() - overallStartTimeRef.current
        : 0;

      recordingRef.current = null;
      setConnectionState('connecting');

      try {
        await activeRecording.stop?.();
      } catch (error) {
        console.error('Error while switching microphone:', error);
      }

      processorRef.current?.onEndpoint();
      processorRef.current?.startNewSession(offsetMs);

      await startNewRecording({
        preserveStartTime: true,
        reuseProcessor: true,
        overrideMicDeviceId: deviceId,
      });
    },
    [setConnectionState, setCurrentMicDeviceId, startNewRecording]
  );

  const rebuildSession = useCallback(async () => {
    const settings = useSettingsStore.getState();
    const current = recordingRef.current;
    if (!current) {
      return;
    }

    const activeRecording = current.recording;
    const offsetMs = overallStartTimeRef.current
      ? Date.now() - overallStartTimeRef.current
      : 0;

    recordingRef.current = null;
    setConnectionState('connecting');

    try {
      await activeRecording.stop?.();
    } catch (error) {
      console.error('Error while rebuilding session:', error);
    }

    processorRef.current?.onEndpoint();
    processorRef.current?.startNewSession(offsetMs);

    await startNewRecording({
      preserveStartTime: true,
      reuseProcessor: true,
      overrideMicDeviceId:
        settings.audioSource === 'mic'
          ? settings.preferredMicDeviceId
          : undefined,
    });
  }, [setConnectionState, startNewRecording]);

  /**
   * 页面刷新后恢复录音。
   * 从 persisted store 读取 recordingStartTime 和 totalPausedMs，
   * 计算正确的时间偏移后重新建立 Soniox 连接。
   */
  const reconnectAfterRefresh = useCallback(async () => {
    const storeState = useTranscriptStore.getState();
    if (!storeState.recordingStartTime) return;

    // 恢复 overallStartTimeRef（刷新后 ref 丢失）
    overallStartTimeRef.current = storeState.recordingStartTime;

    const offsetMs = Date.now() - storeState.recordingStartTime - storeState.totalPausedMs;

    // 把刷新前残留的 preview 文本保存为一个 segment，防止丢失
    let segmentOffset = storeState.segments.length;
    const rescuedPreviewText = combinePreviewText(storeState.currentPreviewText).trim();
    if (rescuedPreviewText) {
      const lastSeg = storeState.segments[storeState.segments.length - 1];
      const previewStartMs = lastSeg ? lastSeg.globalEndMs : offsetMs;

      segmentOffset += 1;
      const rescuedSegment: import('@/types/transcript').TranscriptSegment = {
        id: `seg-${segmentOffset}`,
        sessionIndex: storeState.currentSessionIndex,
        speaker: '',
        language: lastSeg?.language ?? 'en',
        text: rescuedPreviewText,
        globalStartMs: previewStartMs,
        globalEndMs: previewStartMs,
        startMs: previewStartMs,
        endMs: previewStartMs,
        isFinal: true,
        confidence: 1,
        timestamp: lastSeg?.timestamp ?? '00:00:00',
      };
      addFinalSegment(rescuedSegment);

      const rescuedTranslationFinalText =
        storeState.currentPreviewTranslationText.finalText.trim();
      const rescuedTranslationState =
        storeState.currentPreviewTranslationText.nonFinalText.trim()
          ? rescuedTranslationFinalText
            ? 'streaming'
            : 'pending'
          : storeState.currentPreviewTranslationText.state === 'final'
            ? 'final'
            : rescuedTranslationFinalText
              ? 'streaming'
              : 'pending';

      if (rescuedTranslationFinalText || storeState.currentPreviewTranslationText.state !== 'idle') {
        setTranslationEntry(rescuedSegment.id, {
          text: rescuedTranslationFinalText,
          state: rescuedTranslationState,
          sourceLanguage:
            storeState.currentPreviewTranslationText.sourceLanguage ??
            rescuedSegment.language,
        });
      }
    }

    // 清除 preview（已保存为 segment）
    updatePreview({ finalText: '', nonFinalText: '' });
    updatePreviewTranslation({
      finalText: '',
      nonFinalText: '',
      state: 'idle',
      sourceLanguage: null,
    });

    // 创建新的 processor，设置正确的时间偏移
    const processor = ensureProcessor();
    processor.setSegmentCounterOffset(segmentOffset);
    processor.startNewSession(offsetMs);

    setPausedAt(Date.now());
    setRecordingState('paused');
    setConnectionState('reconnecting');
    shouldReconnectRef.current = false;

    await startNewRecording({
      preserveStartTime: true,
      reuseProcessor: true,
      preservePauseStateUntilConnected: true,
    });
  }, [
    addFinalSegment,
    ensureProcessor,
    setConnectionState,
    setPausedAt,
    setRecordingState,
    setTranslationEntry,
    startNewRecording,
    updatePreview,
    updatePreviewTranslation,
  ]);

  const getAudioBlob = useCallback(() => lastAudioBlobRef.current, []);

  return {
    start,
    stop,
    pause,
    switchMicrophone,
    rebuildSession,
    reconnectAfterRefresh,
    getAudioBlob,
    syncRemoteDraft,
    finalizeRemoteDraft,
  };
}
