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
import { isRecordingDraftComplete } from '@/lib/session/recordingLifecycle';
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
// R1-L1：临时 key 的 max_session_duration_seconds 到点 Soniox 会硬断连接（丢最后几秒未 final
// 的字 + 闪断提示）。提前这么多秒主动优雅轮换（重新 mint 接续），把硬断变成平滑切换。
const ROTATION_LEAD_S = 30;
// 连接需持续稳定这么久未再断开，才复位重连退避计数。防止断网抖动(连上→秒断→再连)下
// 每次短暂 WS open 都把计数清零，导致 MAX_RECONNECT_ATTEMPTS 永远到不了、无限重连风暴。
const STABLE_CONNECTION_MS = 8000;
// 分片上传撞 429 后，无 Retry-After 时的默认退避基值。
const CHUNK_BACKOFF_BASE_MS = 3000;
// 主动暂停保留的 Soniox 句柄的存活安全窗口。Soniox 实时连接在无音频/keepalive 约 20s 后被
// 服务端关闭；暂停超过此窗口后，句柄多半已死，resume 复用会「假录音」（UI 在录、无数据流、
// 转录静默丢），改为重建连接。取 15s 留余量。
const PAUSE_HANDLE_STALE_MS = 15_000;

interface UseSonioxOptions {
  idleTimeoutMs?: number;
  audioActivityThreshold?: number;
  onAutoPause?: (reason: 'idle' | 'disconnect') => void;
  onAutoResume?: (reason: 'disconnect') => void;
  /** 断网自动重连达上限、放弃重连时触发（供上层弹出「重连失败，请手动继续」提示）。 */
  onReconnectFailed?: () => void;
  /**
   * 断网续采：网络断开但本地采集仍在继续（音频照常写入，只有 Soniox 转录连接中断）时触发。
   * 与 onAutoPause 的区别在于「录音没有暂停」——供上层提示「转录暂停但录音继续」，而非「已暂停」。
   */
  onTranscriptionInterrupted?: () => void;
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
  const stableConnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // R1-L1：连接寿命轮换定时器 + 轮换实现的 ref 中转（scheduleRotation 需被 attemptReconnect
  // 引用，而轮换本身要走 attemptReconnect —— 经 ref 解开 useCallback 循环依赖）。
  const rotationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rotateConnectionRef = useRef<() => void>(() => {});
  const remoteDraftSeqsRef = useRef<Set<number>>(new Set());
  // 分片上传的 429 退避截止时刻(epoch ms)。窗口内一律短路不再撞限流。
  const chunkBackoffUntilRef = useRef(0);
  const syncDraftPromiseRef = useRef<Promise<boolean> | null>(null);
  const lastAudioActivityAtRef = useRef<number | null>(null);
  const autoPauseReasonRef = useRef<'idle' | 'disconnect' | null>(null);
  const shouldReconnectRef = useRef(false);
  const finalizeOnUnloadSentRef = useRef(false);
  // 单飞闸：手动 start() 的在途 Promise。双击/并发开始时，第二次直接复用同一 Promise，
  // 杜绝并发建立两条 Soniox WS / 两把 temporary key / 双计费（P0-2 #2）。
  const startInFlightRef = useRef<Promise<void> | null>(null);

  // 出字延迟追踪
  const sessionStartWallClockRef = useRef<number | null>(null);
  const latencyEmaRef = useRef<number | null>(null);
  const lastLatencyFlushRef = useRef(0);
  const LATENCY_EMA_ALPHA = 0.3;
  const LATENCY_FLUSH_INTERVAL = 2000; // 每 2 秒更新一次 store
  // 出字延迟合理上限：正常仅秒级，超过 30s 的样本必为暂停复用 WS 或时钟异常，丢弃（U58）
  const MAX_PLAUSIBLE_LATENCY_MS = 30_000;

  const addFinalSegment = useTranscriptStore((s) => s.addFinalSegment);
  const updatePreview = useTranscriptStore((s) => s.updatePreview);
  const updatePreviewTranslation = useTranscriptStore((s) => s.updatePreviewTranslation);
  const setConnectionState = useTranscriptStore((s) => s.setConnectionState);
  const setConnectionMeta = useTranscriptStore((s) => s.setConnectionMeta);
  const setBackupMeta = useTranscriptStore((s) => s.setBackupMeta);
  const resetBackupMeta = useTranscriptStore((s) => s.resetBackupMeta);
  const setRecordingState = useTranscriptStore((s) => s.setRecordingState);
  const setRecordingStartTime = useTranscriptStore((s) => s.setRecordingStartTime);
  const setActiveSessionId = useTranscriptStore((s) => s.setActiveSessionId);
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
  const onReconnectFailed = options.onReconnectFailed;
  const onTranscriptionInterrupted = options.onTranscriptionInterrupted;

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

      // 429 退避窗口内直接短路，不发网络请求 —— 避免「无退避重传 → 更多 429」的正反馈风暴。
      if (Date.now() < chunkBackoffUntilRef.current) {
        publishBackupMeta({
          localChunkCount,
          remoteChunkCount: remoteDraftSeqsRef.current.size,
          syncState: 'pending',
          lastError: 'Backup upload is backing off after rate limiting',
        });
        return false;
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
          if (response.status === 429) {
            // 尊重服务端 Retry-After；缺省用基值退避。窗口内后续上传/补传会被上面的短路拦下。
            const retryAfter = Number(response.headers.get('Retry-After'));
            const backoffMs =
              Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : CHUNK_BACKOFF_BASE_MS;
            chunkBackoffUntilRef.current = Date.now() + backoffMs;
          }
          publishBackupMeta({
            localChunkCount,
            remoteChunkCount: remoteDraftSeqsRef.current.size,
            syncState: 'pending',
            lastError: 'Some audio chunks are still waiting to upload',
          });
          return false;
        }

        // 成功即解除退避（限流已恢复）。
        chunkBackoffUntilRef.current = 0;
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

        // 默认保留本会话已知「已成功上传」的 seq 集合：GET /audio/draft 失败(!ok 或抛错)时
        // 绝不清零，否则会误判「服务端啥都没有」而把全部分片重传一遍——正是造成
        // 「录音结束疯狂同步 chunks / 撞限流 429 / 会话收不了尾」的放大器。
        let remoteSeqs = new Set<number>(remoteDraftSeqsRef.current);
        try {
          const response = await fetch(`/api/sessions/${sessionId}/audio/draft`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (response.ok) {
            const data = (await response.json()) as { seqs?: number[] };
            // GET 成功：以服务端为权威（可能比本地记录少 = 确有分片没传上去，需补传）
            remoteSeqs = new Set(
              Array.isArray(data.seqs) ? data.seqs.filter(Number.isInteger) : []
            );
          }
          // GET 返回 !ok：保留上面的本地已知集合，只补真正缺失的（不全量重传）
        } catch {
          // 网络异常同理：保留本地已知集合，避免全量重传打爆限流
        }

        remoteDraftSeqsRef.current = remoteSeqs;
        // 服务端已有这些 seq → 把归档的下一个分片号推到服务端最大值之上，避免续录/换设备时
        // 新分片撞上服务端残留旧 seq 被误判「已上传」而跳过补传（审计 high）。仅前进不后退。
        if (remoteSeqs.size > 0) {
          const remoteMaxSeq = Math.max(...remoteSeqs);
          archiveManagerRef.current?.ensureSeqAbove(remoteMaxSeq + 1);
        }
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

          // 退避窗口内直接停止本轮补传（而非逐个撞限流），剩余缺失分片留待下次触发。
          if (Date.now() < chunkBackoffUntilRef.current) {
            hadFailures = true;
            break;
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

  // P0-4 契约1：冷启动/续录 recorder.start() 之前先 GET 服务端草稿清单，拿到 nextSeq
  // （= 服务端 maxSeq+1），据此设定归档起始 seq，杜绝从 0 起覆盖服务端已有录音开头。
  // 无草稿 / 请求失败时返回 undefined，由 ensureArchive 退回本地推导（全新会话从 0）。
  const negotiateStartSeq = useCallback(async (): Promise<number | undefined> => {
    if (!sessionId || !token) {
      return undefined;
    }
    try {
      const response = await fetch(
        `/api/sessions/${sessionId}/audio/draft/chunks`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!response.ok) {
        return undefined;
      }
      const data = (await response.json()) as {
        nextSeq?: number;
        maxSeq?: number;
      };
      if (
        typeof data.nextSeq === 'number' &&
        Number.isFinite(data.nextSeq) &&
        data.nextSeq >= 0
      ) {
        return Math.floor(data.nextSeq);
      }
      return undefined;
    } catch {
      // 网络异常：不阻塞开录，退回本地推导（syncRemoteDraft 仍会在开录后二次校准 seq）。
      return undefined;
    }
  }, [sessionId, token]);

  const finalizeRemoteDraft = useCallback(async () => {
    if (!sessionId || !token) {
      return false;
    }

    let localSeqs: number[] = [];
    try {
      localSeqs = sessionId
        ? (await getAudioChunkEntries(sessionId)).map((entry) => entry.seq)
        : [];
    } catch {
      // 读本地失败：退回已知计数，用连续 [0..count-1] 近似本地 seq，保证 stop 仍能推进。
      const knownCount = useTranscriptStore.getState().backupMeta.localChunkCount;
      localSeqs = Array.from({ length: Math.max(0, knownCount) }, (_, i) => i);
    }
    const localChunkCount = localSeqs.length;

    publishBackupMeta({
      localChunkCount,
      remoteChunkCount: remoteDraftSeqsRef.current.size,
      syncState: 'syncing',
    });

    await syncRemoteDraft();

    // P0-5 契约2：完整性用「集合包含」判定 —— 期望区间 [0..maxSeq] 每个 seq 都必须已在远端
    // （含首块 seq 0）。旧的数量判断会把 local=[0,1]/remote=[0,9] 误判完整而清掉唯一副本。
    const audioComplete = isRecordingDraftComplete(
      localSeqs,
      remoteDraftSeqsRef.current
    );

    // 不完整（补传缺尾：持续 429 退避 / 断网 / leading gap）：绝不 seal、绝不 POST finalize、
    // 绝不置会话终态。保留服务端草稿与本地 IndexedDB 完整副本，如实回报 false 供上层保留数据、
    // 走重试/恢复路径（审计 P0-5 critical：停止收尾丢尾部音频 / 清掉唯一完整副本）。
    if (!audioComplete) {
      publishBackupMeta({
        localChunkCount,
        remoteChunkCount: remoteDraftSeqsRef.current.size,
        syncState: 'pending',
        lastError: 'Some audio is not yet backed up to the server',
      });
      return false;
    }

    try {
      // P1-7 契约3 阶段①（SEAL）：先封存草稿再收尾。封存后服务端对迟到的 audio-chunk /
      // transcript-draft 写入一律 409，杜绝「merge 读快照 → 删草稿」之间的丢尾窗口。
      const sealResponse = await fetch(
        `/api/sessions/${sessionId}/audio/draft/finalize?phase=seal`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      // 409：会话已被并发收尾/回收（终态）——视为需重试，绝不吞数据、绝不清库。
      if (sealResponse.status === 409) {
        publishBackupMeta({
          localChunkCount,
          remoteChunkCount: remoteDraftSeqsRef.current.size,
          syncState: 'pending',
          lastError: 'Recording draft is sealed or already finalized; retry needed',
        });
        return false;
      }
      if (!sealResponse.ok) {
        publishBackupMeta({
          localChunkCount,
          remoteChunkCount: remoteDraftSeqsRef.current.size,
          syncState: 'pending',
          lastError: 'Failed to seal server backup',
        });
        return false;
      }

      // 阶段②：正式收尾（合并 + 服务端二次完整性校验 + CAS 提交）。
      const response = await fetch(
        `/api/sessions/${sessionId}/audio/draft/finalize`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      // 409：服务端合并阶段发现缺口（hasGap / leading gap）或会话已终态 —— 需重试，保留数据。
      if (response.status === 409) {
        publishBackupMeta({
          localChunkCount,
          remoteChunkCount: remoteDraftSeqsRef.current.size,
          syncState: 'pending',
          lastError: 'Server detected missing chunks; retry needed',
        });
        return false;
      }
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
        remoteChunkCount: remoteDraftSeqsRef.current.size,
        syncState: localChunkCount > 0 ? 'synced' : 'idle',
        lastError: null,
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

  // 取消「稳定连接」计时器（连接又断开/进入重连/停止时调用），使抖动不会复位退避计数。
  const cancelStableConn = useCallback(() => {
    if (stableConnTimerRef.current) {
      clearTimeout(stableConnTimerRef.current);
      stableConnTimerRef.current = null;
    }
  }, []);

  // WS 'connected' 后不立即复位退避计数，而是等连接持续稳定 STABLE_CONNECTION_MS 未再断开
  // 才复位。任一断开/重连/停止都会 cancelStableConn 取消本计时器，从而让断网抖动不断累计
  // reconnectAttemptsRef、MAX_RECONNECT_ATTEMPTS 封顶得以真正生效，杜绝无限重连风暴。
  const markConnectedStable = useCallback(() => {
    if (stableConnTimerRef.current) {
      clearTimeout(stableConnTimerRef.current);
    }
    stableConnTimerRef.current = setTimeout(() => {
      reconnectAttemptsRef.current = 0;
      stableConnTimerRef.current = null;
    }, STABLE_CONNECTION_MS);
  }, []);

  // 续录/重连时传给 processor.startNewSession 的时间偏移（=已录音频毫秒）。
  // 暂停中（pausedAt 有值）以 pausedAt 为「当前音频时刻」冻结点，避免把暂停/断网空档
  // （pausedAt→now）当成音频时长算进偏移——否则重连/切麦/重建后段落时间戳整体前移那段空档。
  // 未暂停（pausedAt 为空，如录制中重建）用 now。Math.max(0) 兜底抖动下 totalPausedMs 虚高致负。
  // 与 accumulatePausedTime（连接完成后把空档折进 totalPausedMs 供计时）配合但不双算：offset 用
  // pausedAt 冻结点、totalPausedMs 此刻尚未含本次空档，故一次性正确。overallStart 为空返回 0。
  const computeResumeOffset = useCallback(() => {
    if (!overallStartTimeRef.current) return 0;
    const { pausedAt, totalPausedMs } = useTranscriptStore.getState();
    const ref = pausedAt ?? Date.now();
    return Math.max(0, ref - overallStartTimeRef.current - totalPausedMs);
  }, []);

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
      // 手动暂停/恢复复用同一 WS，不会重置 sessionStartWallClockRef，
      // 而 SDK resume 后 token end_ms 不含暂停墙钟间隔，导致 latency 被整段
      // 暂停时长虚高（可达数分钟），EMA 收敛到该虚值、延迟徽标永久卡住。
      // 出字延迟只会是秒级，超过阈值的样本必为暂停/时钟异常，直接丢弃（U58）。
      if (latency > MAX_PLAUSIBLE_LATENCY_MS) return;

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

      // 连接刚断，取消尚未触发的稳定复位，让本次断网计入重连计数。
      cancelStableConn();

      // ── 断网续采 ──
      // 网络断开、但本地采集(MediaRecorder)仍活着时：只停 Soniox 转录发送，让 archiveManager
      // 继续把音频写入 IndexedDB —— 断网空档的音频不再丢失（转录空洞留待重连后 Soniox 从连续
      // offset 续接 / 后续异步补全）。recordingState 保持 'recording'，不进暂停语义、不 setPausedAt，
      // 时间轴连续、offset 不需扣除断网空档。仅在本地采集也不可用时才回退到完整暂停。
      if (reason === 'disconnect' && archiveManagerRef.current?.hasLiveCapture()) {
        shouldReconnectRef.current = true;
        const current = recordingRef.current;
        recordingRef.current = null;
        runIdRef.current += 1;
        try {
          await current?.recording.stop?.();
        } catch (error) {
          console.error('Error stopping Soniox during disconnect (continuous capture):', error);
        }
        processorRef.current?.onEndpoint();
        // 不 pause archiveManager、不 setPausedAt、recordingState 保持 recording
        setConnectionState('reconnecting');
        autoPauseReasonRef.current = 'disconnect';
        onTranscriptionInterrupted?.();
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

      // 连接已死/即将停：寿命轮换随之作废（重连/恢复成功拿到新 key 时会重新 schedule）。
      if (rotationTimerRef.current) {
        clearTimeout(rotationTimerRef.current);
        rotationTimerRef.current = null;
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
    [
      cancelStableConn,
      onAutoPause,
      onTranscriptionInterrupted,
      setConnectionState,
      setPausedAt,
      setRecordingState,
    ]
  );

  // R1-L1：安排连接寿命轮换。key 响应带 max_session_duration_seconds（=本次预扣分钟），到点
  // Soniox 服务端硬断；提前 ROTATION_LEAD_S 主动轮换。稳定引用（无依赖）：实际轮换经
  // rotateConnectionRef 中转，可被 attemptReconnect 安全引用而不成环。
  const scheduleRotation = useCallback((maxSessionSeconds?: number) => {
    if (rotationTimerRef.current) {
      clearTimeout(rotationTimerRef.current);
      rotationTimerRef.current = null;
    }
    // 太短的窗口（收缩到只剩 1 分钟的额度尾巴）不轮换：让 Soniox 硬断 + 既有断线重连兜底，
    // 重连时若额度真耗尽会被 mint 403 拒绝并走重连失败提示。
    if (!maxSessionSeconds || maxSessionSeconds <= ROTATION_LEAD_S * 2) {
      return;
    }
    rotationTimerRef.current = setTimeout(
      () => {
        rotationTimerRef.current = null;
        rotateConnectionRef.current();
      },
      (maxSessionSeconds - ROTATION_LEAD_S) * 1000
    );
  }, []);

  // 内部重连函数 — 断网后自动尝试重新建立 Soniox 连接
  const attemptReconnect = useCallback(
    async () => {
      // 清掉任何还未触发的上一次重连定时器，避免 onError + catch 同时触发时堆叠多个 WS 尝试
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      // 进入新的重连周期，取消任何待触发的稳定复位。
      cancelStableConn();

      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        console.error('Max reconnect attempts reached, giving up');
        shouldReconnectRef.current = false;
        setConnectionState('error');
        if (!(await canRecoverLocally())) {
          setRecordingState('paused');
        }
        reconnectAttemptsRef.current = 0;
        // 明确通知上层「重连失败」——否则会话停在 paused、connectionState='error' 的红标又被
        // isActive 挡住，用户看不到失败信号(静默死)。上层据此弹持久提示引导手动点「继续」重连。
        onReconnectFailed?.();
        return;
      }

      reconnectAttemptsRef.current += 1;
      const attempt = reconnectAttemptsRef.current;
      const delay = RECONNECT_BASE_DELAY_MS * Math.pow(1.5, attempt - 1);
      console.log(`Reconnecting attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay)}ms...`);

      setConnectionState('reconnecting');

      reconnectTimerRef.current = setTimeout(async () => {
        // 记录进入本次重连时的 runId 代际：ensureArchive / getSenderStream 等 await 之后据此
        // 判断期间是否发生了 stop / 卸载（两者都会递增 runId），若是则放弃，避免在已停止/
        // 已卸载的会话上复活一条录音流（审计 high）。
        const genAtStart = runIdRef.current;
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

        // 减去累计暂停时长，否则先前暂停过的会话在重连后所有段落时间戳
        // 会前移整段暂停时长、超出实际（已扣暂停）音频长度（U57），与
        // reconnectAfterRefresh 的算法保持一致。
        const offsetMs = computeResumeOffset();

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

          // await（ensureArchive / getSenderStream）期间用户可能已 stop 或组件已卸载 ——
          // 建立新 Soniox 连接前再复查一次，否则会白建一条 WS 并把已停止的会话复活成录音态。
          if (runIdRef.current !== genAtStart) {
            shouldReconnectRef.current = false;
            reconnectAttemptsRef.current = 0;
            return;
          }
          const latestState = useTranscriptStore.getState().recordingState;
          if (
            latestState === 'idle' ||
            latestState === 'stopped' ||
            latestState === 'finalizing'
          ) {
            shouldReconnectRef.current = false;
            reconnectAttemptsRef.current = 0;
            return;
          }

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
                  markConnectedStable();
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
                } else {
                  cancelStableConn();
                }
              },
            },
            {
              sourceType,
              deviceId: sourceType === 'mic' ? selectedMicDeviceId : undefined,
              managedStream,
              regionPreference: settings.sonioxRegionPreference,
              attribution: { kind: 'realtime', sessionId },
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
            scheduleRotation(result.temporaryKey.max_session_duration_seconds);
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
      computeResumeOffset,
      cancelStableConn,
      markConnectedStable,
      onReconnectFailed,
      accumulatePausedTime,
      audioActivityThreshold,
      markAudioActivity,
      onAutoResume,
      pauseForInterruption,
      scheduleRotation,
      sessionId,
      setConnectionMeta,
      setConnectionState,
      setRecordingState,
      syncRemoteDraft,
      updateTranscriptionLatency,
      uploadDraftChunk,
    ]
  );

  // R1-L1：主动寿命轮换。与 pauseForInterruption 同款代际机制：先递增 runId 使旧句柄的
  // onError/onConnectionChange 全部失效（stop 触发的回调不会误入「断线自动暂停」路径），
  // 再优雅 stop 旧连接（flush 已缓冲音频的 final token），随即走既有 attemptReconnect 状态机
  // 重新 mint（新预扣、新 grant）接续转录。归档采集不经 Soniox——轮换期间音频零丢失；转录
  // 空隙 ~1-2s（重连退避 + 建连），远好于硬断（丢最后 ~5s 未 final 的字 + 中断提示）。
  const rotateConnection = useCallback(() => {
    // 仅在录音进行中且句柄健在时轮换；暂停/收尾/断线中（重连状态机已接管）都跳过——那些
    // 路径恢复时自会重新 mint 并重新 schedule。
    if (useTranscriptStore.getState().recordingState !== 'recording') {
      return;
    }
    const current = recordingRef.current;
    if (!current) {
      return;
    }
    recordingRef.current = null;
    runIdRef.current += 1;
    void (async () => {
      try {
        await current.recording.stop?.();
      } catch {
        // 旧句柄回调已失效，stop 失败无副作用（连接反正会被 Soniox 到点断掉）
      }
    })();
    reconnectAttemptsRef.current = 0;
    shouldReconnectRef.current = true;
    void attemptReconnect();
  }, [attemptReconnect]);

  useEffect(() => {
    rotateConnectionRef.current = rotateConnection;
  }, [rotateConnection]);

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

      // ensureProcessor 会把新建实例写入 processorRef，故须在解析前先记录是否复用了旧实例。
      const reusedExistingProcessor = Boolean(
        startOptions?.reuseProcessor && processorRef.current
      );
      const processor = reusedExistingProcessor
        ? processorRef.current!
        : ensureProcessor();

      // 复用 processor 时重新同步目标语言：ensureProcessor 仅在创建时 setTargetLang，
      // 录制中改目标语言（SettingsDrawer Apply → rebuildSession → reuseProcessor）后
      // 若不重设，processor 的 targetLang 保持旧值，新目标语言的段落无法 passthrough，
      // 永久卡在「translating…」（U37）。
      processor.setTargetLang(settings.targetLang);

      // 冷恢复（后端 draft 重建、store 由 idle 拉起）后 wasRecordingRef 为 false，
      // reconnectAfterRefresh 从未运行，overallStartTimeRef 与 processor 段偏移都为空。
      // 此时用户点『继续』走 start→startNewRecording(preserveStartTime)，若不回退读取
      // store.recordingStartTime，startedAt 会退化为 now → 计时清零、已录时长丢失（U21）。
      const coldResumeStartTime =
        startOptions?.preserveStartTime && !overallStartTimeRef.current
          ? useTranscriptStore.getState().recordingStartTime
          : null;
      const startedAt =
        startOptions?.preserveStartTime && overallStartTimeRef.current
          ? overallStartTimeRef.current
          : coldResumeStartTime ?? Date.now();
      const keepPausedUntilConnected =
        startOptions?.preservePauseStateUntilConnected &&
        previousRecordingState === 'paused';

      // 冷恢复且此次是新建的 processor（未复用旧实例）时，恢复段计数偏移与会话时间偏移，
      // 使续录段号紧接已恢复段（不与 seg-1..seg-N 串号），且全局时间戳从已录时长续接。
      // 复用旧实例的路径（switchMic/rebuild/热恢复）已在各自调用处 startNewSession，跳过。
      // 会话时间偏移取「已录时长」= pausedAt - startTime - totalPausedMs（暂停态续录起点），
      // 而非 now-startTime，避免把 draft 恢复到点击『继续』之间的静置时长计入音频时间轴。
      if (coldResumeStartTime && !reusedExistingProcessor) {
        const storeState = useTranscriptStore.getState();
        const resumeOffsetMs = Math.max(
          0,
          (storeState.pausedAt ?? Date.now()) -
            coldResumeStartTime -
            storeState.totalPausedMs
        );
        processor.setSegmentCounterOffset(storeState.segments.length);
        processor.startNewSession(resumeOffsetMs);
      }

      overallStartTimeRef.current = startedAt;
      setRecordingStartTime(startedAt);
      // 绑定全局 store 到本会话：后续别的会话页挂载时据 activeSessionId 判定这些
      // segments/计时/recordingState 不属于它，杜绝跨会话串数据（P0-3）。
      if (sessionId) {
        setActiveSessionId(sessionId);
      }
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
        // P1-10：硬件掉线（麦克风拔出 / 系统共享停止，源 track ended）时，若归档已无实时
        // 采集，UI 不应继续显示 recording。反映为 paused + 断连，让用户看到明确信号。
        archiveManager.setCaptureEndedHandler(() => {
          if (archiveManagerRef.current !== archiveManager) {
            return;
          }
          if (archiveManager.hasLiveCapture()) {
            return;
          }
          setConnectionState('disconnected');
          if (useTranscriptStore.getState().recordingState === 'recording') {
            setPausedAt(Date.now());
            setRecordingState('paused');
          }
        });
        // P0-4：recorder.start() 之前先与服务端协商起始 seq（nextSeq = 服务端 maxSeq+1），
        // 冷启动/续录都据此设定归档起点，杜绝从 0 起覆盖服务端已有录音开头。
        const negotiatedStartSeq = await negotiateStartSeq();
        await archiveManager.ensureArchive({
          sourceType,
          deviceId: sourceType === 'mic' ? selectedMicDeviceId : undefined,
          preAcquiredStream,
          preserveData: startOptions?.preserveStartTime,
          startedAt,
          initialSeq: negotiatedStartSeq,
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
                markConnectedStable();
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
              } else {
                cancelStableConn();
              }
            },
          },
          {
            sourceType,
            deviceId: sourceType === 'mic' ? selectedMicDeviceId : undefined,
            managedStream,
            regionPreference: settings.sonioxRegionPreference,
            attribution: { kind: 'realtime', sessionId },
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
          scheduleRotation(result.temporaryKey.max_session_duration_seconds);
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

        // 晚到的 start 结果对齐用户最新意图（P0-2 #1）：async 建连期间用户若手动暂停，
        // store.recordingState 已是 'paused'，但刚发布的句柄默认在 recording，会继续写
        // segment 造成「UI 暂停却仍出字」。此处立即暂停句柄与归档。
        // 刻意排除 keepPausedUntilConnected：那是「暂停态切麦/重建，连上后自动 resume」的
        // 既有流程，其 resume 由 onConnectionChange('connected') 分支负责，不能在此干预。
        if (
          !keepPausedUntilConnected &&
          useTranscriptStore.getState().recordingState === 'paused'
        ) {
          try {
            result.recording.pause?.();
          } catch (error) {
            console.error('Failed to pause late start handle:', error);
          }
          void archiveManagerRef.current?.pause();
        }
      } catch (error) {
        if (runId !== runIdRef.current) {
          return;
        }

        console.error('Failed to start recording:', error);
        // P1-2：区分「仍有实时采集(hasLiveCapture)」与「仅有可恢复历史块」。只有前者才可
        // 保持 recording；后者归档已停/句柄为空，继续显示 recording 会形成「计时继续但无音频」
        // 的假录音，应落到 paused（靠 resume-cold / 手动继续兜底）。
        const hasLive = Boolean(archiveManagerRef.current?.hasLiveCapture());
        const recoverable = hasLive || (await canRecoverLocally());
        if (!startOptions?.reuseProcessor && !recoverable) {
          processorRef.current = null;
        }
        setConnectionState('error');
        if (!recoverable) {
          setRecordingState('idle');
          return;
        }
        const keepRecording = hasLive && previousRecordingState !== 'paused';
        setRecordingState(keepRecording ? 'recording' : 'paused');
        // P1-5：初始 temporary-key/WS 建连失败，但本地归档已在采集(hasLive)、且非暂停续录：
        // 与运行中断线走同一条自动重连状态机（attemptReconnect），而不是静默停在
        // recording/error 让实时转录永不自行恢复（审计 P1-5）。归档不受影响，仅重建转录连接。
        if (keepRecording) {
          shouldReconnectRef.current = true;
          onTranscriptionInterrupted?.();
          attemptReconnect();
        }
      }
    },
    [
      accumulatePausedTime,
      audioActivityThreshold,
      canRecoverLocally,
      cancelStableConn,
      markConnectedStable,
      ensureProcessor,
      markAudioActivity,
      onAutoResume,
      onTranscriptionInterrupted,
      pauseForInterruption,
      setConnectionState,
      setCurrentMicDeviceId,
      setConnectionMeta,
      publishBackupMeta,
      resetBackupMeta,
      setRecordingStartTime,
      setActiveSessionId,
      setPausedAt,
      setRecordingState,
      negotiateStartSeq,
      scheduleRotation,
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
      const store = useTranscriptStore.getState();
      if (store.recordingState !== 'recording') {
        return;
      }
      // 断网续采期间转录连接未连上，没有 Soniox token/电平活动属正常现象，绝不能据此按
      // idle 自动暂停打断正在继续的本地录音（否则断网续采会在 5min 后被误暂停）。
      if (store.connectionState !== 'connected') {
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

  // 组件卸载时清掉 pending 重连定时器，避免在已卸载后仍尝试新建 WS，
  // 并兜底停止仍在运行的麦克风 / Soniox WS / 归档 MediaRecorder。
  //
  // C0/G1：SPA 导航离开录制页会卸载本 hook，但用户从未点「停止」。此前卸载
  // 只清 reconnectTimer，麦克风、Soniox WS（recordingRef）、归档 MediaRecorder
  // （archiveManagerRef）继续运行，其回调靠永不再变的 runId 持续写全局 store、
  // 上传 draft chunk，形成无法在应用内停止的孤儿录音（麦克风常亮、按分钟计费、
  // draft 一直刷新使 reclaimStaleSessions 永不回收）。
  //
  // 这里递增 runId 使所有在途回调立即失效，再停止硬件并置空 refs。
  // 刻意不改动 recordingState —— 保留 recording/paused 供返回页面时按刷新恢复
  // 逻辑（reconnectAfterRefresh）续录，与既有 beforeunload/刷新恢复模型一致。
  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (stableConnTimerRef.current) {
        clearTimeout(stableConnTimerRef.current);
        stableConnTimerRef.current = null;
      }
      if (rotationTimerRef.current) {
        clearTimeout(rotationTimerRef.current);
        rotationTimerRef.current = null;
      }

      // 使在途录音回调失效，防止孤儿实例继续写 store / 上传 chunk
      runIdRef.current += 1;

      // P1-3：停硬件的同一时刻冻结暂停点。SPA 导航离开会卸载本 hook 并停止硬件，但 store
      // 内存单例不销毁、recordingState 保留为 recording。若此刻不冻结 pausedAt，返回页面时
      // reconnectAfterRefresh / computeResumeOffset 会以「返回那一刻」(now) 作为冻结点，把整段
      // 离页无音频空档算进 processor offset、elapsed 与服务端 duration（审计 P1-3）。以卸载
      // 这一刻作为暂停起点后，离页空档被正确排除。仅在录音态且尚未冻结时设置，不覆盖既有暂停点。
      {
        const store = useTranscriptStore.getState();
        if (store.recordingState === 'recording' && store.pausedAt == null) {
          store.setPausedAt(Date.now());
        }
      }

      const orphanRecording = recordingRef.current;
      const orphanArchiveManager = archiveManagerRef.current;
      recordingRef.current = null;
      archiveManagerRef.current = null;

      if (orphanRecording) {
        try {
          void Promise.resolve(orphanRecording.recording.stop?.()).catch(() => {});
        } catch {
          /* best-effort teardown on unmount */
        }
      }
      if (orphanArchiveManager) {
        try {
          void Promise.resolve(orphanArchiveManager.stop()).catch(() => {});
        } catch {
          /* best-effort teardown on unmount */
        }
      }

      // 硬件已停，连接确实死了 —— 让全局 store 的 connectionState 诚实反映。
      // connectionState 不进 partialize，SPA 导航（store 内存单例不销毁）返回时若残留
      // 'connected'，会导致连接指示器虚假常绿、且刷新恢复闸门误判（审计 high：假录音僵尸）。
      setConnectionState('disconnected');
    };
  }, [setConnectionState]);

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

  const startImpl = useCallback(async () => {
    // 手动开始/继续录音时接管连接生命周期：取消任何待触发/进行中的自动重连，否则它稍后
    // 会再开出第二条 Soniox WS，与本次手动建立的连接并存 → 旧句柄被覆盖却不 stop，形成
    // 双流、双计费（审计 high）。stop() 已有同款接管逻辑，这里对齐。
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (rotationTimerRef.current) {
      clearTimeout(rotationTimerRef.current);
      rotationTimerRef.current = null;
    }
    cancelStableConn();
    reconnectAttemptsRef.current = 0;
    shouldReconnectRef.current = false;

    // 暂停时长超过句柄存活窗口 → 保留的 Soniox 句柄多半已被服务端关闭，复用会「假录音」
    // （审计 high）。清掉旧句柄，落到下面重建一条新连接。
    const pausedAtSnapshot = useTranscriptStore.getState().pausedAt;
    const pausedForMs = pausedAtSnapshot ? Date.now() - pausedAtSnapshot : 0;
    const handleLikelyStale = pausedForMs > PAUSE_HANDLE_STALE_MS;

    if (recordingRef.current && recordingState === 'paused' && handleLikelyStale) {
      try {
        await recordingRef.current.recording.stop?.();
      } catch {
        /* best-effort：旧句柄可能已死，忽略 */
      }
      recordingRef.current = null;
    }

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

    const reuseProcessor =
      recordingState === 'recording' || recordingState === 'paused';

    // 自动暂停（idle/断连）后 recordingRef 已被置空，走此 fall-through 复用
    // processor 打开新 Soniox WS。新连接的 token start_ms 从 0 重新计时，
    // 若不调 startNewSession(offset)，复用的 processor 仍持旧会话 timeOffsetMs，
    // 导致 resume 后所有段落时间戳错位（C12）。与 attemptReconnect /
    // switchMicrophone / rebuildSession / reconnectAfterRefresh 四条同类路径对齐。
    if (reuseProcessor && processorRef.current && overallStartTimeRef.current) {
      const offsetMs = computeResumeOffset();
      processorRef.current.onEndpoint();
      processorRef.current.startNewSession(offsetMs);
    }

    await startNewRecording({
      preserveStartTime:
        recordingState === 'recording' || recordingState === 'paused',
      reuseProcessor,
      preservePauseStateUntilConnected: recordingState === 'paused',
    });
  }, [
    accumulatePausedTime,
    cancelStableConn,
    computeResumeOffset,
    markAudioActivity,
    recordingState,
    setConnectionState,
    setRecordingState,
    startNewRecording,
  ]);

  // 对外的 start：单飞包装。并发/双击时复用同一在途 Promise，保证 startImpl（进而
  // startSonioxRecording）在一次 start 生命周期内只跑一次，杜绝双 WS / 双计费（P0-2 #2）。
  const start = useCallback(async () => {
    if (startInFlightRef.current) {
      return startInFlightRef.current;
    }
    const run = startImpl().finally(() => {
      startInFlightRef.current = null;
    });
    startInFlightRef.current = run;
    return run;
  }, [startImpl]);

  const stop = useCallback(async () => {
    // 取消任何正在进行的重连
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (rotationTimerRef.current) {
      clearTimeout(rotationTimerRef.current);
      rotationTimerRef.current = null;
    }
    cancelStableConn();
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
  }, [cancelStableConn, sessionId, setConnectionState, setRecordingStartTime, setRecordingState]);

  const pause = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    // 暂停即撤销寿命轮换：暂停中无音频采集，被 Soniox 到点硬断零损失；恢复时短暂停复用句柄
    // 靠「硬断→自动重连」兜底、长暂停走重建（新 mint 会重新 schedule）。
    if (rotationTimerRef.current) {
      clearTimeout(rotationTimerRef.current);
      rotationTimerRef.current = null;
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
      // 减去暂停时长/空档，避免切换麦克风后段落时间戳前移（U57）。见 computeResumeOffset。
      const offsetMs = computeResumeOffset();

      recordingRef.current = null;
      setConnectionState('connecting');

      // P0-2：捕获停旧录音这一步之前的代次。stop?.() 的 await 期间用户若点了『停止』，
      // stop() 会 bump runId 并把 recordingState 迁到 finalizing/stopped——续录必须中止。
      const genBeforeStop = runIdRef.current;
      try {
        await activeRecording.stop?.();
      } catch (error) {
        console.error('Error while switching microphone:', error);
      }

      // P0-2 residual：await 期间若录音已被停止（recordingState=stopped/idle），或代次已越过
      // 捕获值（stop()/断网都会 bump runId），说明这条切麦克风的续录已经作废——绝不能再
      // startNewRecording「停止后又复活录音」。此处尚未获取新流，无残留流需释放。
      const stateAfterStop = useTranscriptStore.getState().recordingState;
      if (
        stateAfterStop === 'stopped' ||
        stateAfterStop === 'idle' ||
        runIdRef.current !== genBeforeStop
      ) {
        return;
      }

      processorRef.current?.onEndpoint();
      processorRef.current?.startNewSession(offsetMs);

      // 暂停态下切麦克风：保持暂停直至新连接建立，避免静默恢复录音、
      // pausedAt 残留与整段暂停时长被计入计费（U20）。重连完成分支会
      // accumulatePausedTime 并恢复录音。
      await startNewRecording({
        preserveStartTime: true,
        reuseProcessor: true,
        overrideMicDeviceId: deviceId,
        preservePauseStateUntilConnected:
          useTranscriptStore.getState().recordingState === 'paused',
      });
    },
    [computeResumeOffset, setConnectionState, setCurrentMicDeviceId, startNewRecording]
  );

  const rebuildSession = useCallback(async () => {
    const settings = useSettingsStore.getState();
    const current = recordingRef.current;
    if (!current) {
      return;
    }

    const activeRecording = current.recording;
    // 减去暂停时长/空档，避免重建会话后段落时间戳前移（U57）。见 computeResumeOffset。
    const offsetMs = computeResumeOffset();

    recordingRef.current = null;
    setConnectionState('connecting');

    // P0-2：捕获停旧录音这一步之前的代次（同 switchMicrophone）。
    const genBeforeStop = runIdRef.current;
    try {
      await activeRecording.stop?.();
    } catch (error) {
      console.error('Error while rebuilding session:', error);
    }

    // P0-2 residual：await 期间录音被停止（stopped/idle）或代次已越过捕获值 → 中止重建，
    // 绝不 startNewRecording 复活录音。此处尚未获取新流，无残留流需释放。
    const stateAfterStop = useTranscriptStore.getState().recordingState;
    if (
      stateAfterStop === 'stopped' ||
      stateAfterStop === 'idle' ||
      runIdRef.current !== genBeforeStop
    ) {
      return;
    }

    processorRef.current?.onEndpoint();
    processorRef.current?.startNewSession(offsetMs);

    // 暂停态下应用设置（SettingsDrawer Apply → rebuildSession）：保持暂停直至新连接
    // 建立，避免静默恢复录音、pausedAt 残留与整段暂停时长被计入计费（U20）。
    await startNewRecording({
      preserveStartTime: true,
      reuseProcessor: true,
      overrideMicDeviceId:
        settings.audioSource === 'mic'
          ? settings.preferredMicDeviceId
          : undefined,
      preservePauseStateUntilConnected:
        useTranscriptStore.getState().recordingState === 'paused',
    });
  }, [computeResumeOffset, setConnectionState, startNewRecording]);

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

    // 暂停态刷新：用暂停冻结点 pausedAt 算 offset，暂停空档不计入录音时长（与
    // computeResumeOffset 一致）；录音态刷新（pausedAt 为空）等价于在刷新这一刻暂停，用 now。
    // 加负值护栏。旧代码一律用 Date.now()，暂停挂机后刷新会把整段空档算进续录偏移，
    // 导致后续段时间戳整体前移（审计 high）。
    const freezePoint = storeState.pausedAt ?? Date.now();
    const offsetMs = Math.max(
      0,
      freezePoint - storeState.recordingStartTime - storeState.totalPausedMs
    );

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

    // 刷新恢复只把会话还原为「暂停展示」态，绝不自动开麦续录：
    // 已恢复 processor / 段号偏移 / overallStartTimeRef，用户点「继续」时 start() 的
    // 复用分支(Branch 3)会据此接上并续录。此处不建立 Soniox 连接、不抢麦。
    //
    // 保留暂停冻结点：刷新前若已是暂停态，pausedAt 维持原值，否则刷新前的暂停空档会在
    // 点「继续」时（accumulatePausedTime / computeResumeOffset）漏扣、被当作录音时长
    // （审计 high）。刷新前是录音态（pausedAt 为空）才以刷新这一刻作为暂停起点。
    if (storeState.pausedAt == null) {
      setPausedAt(Date.now());
    }
    setRecordingState('paused');
    setConnectionState('disconnected');
    shouldReconnectRef.current = false;
  }, [
    addFinalSegment,
    ensureProcessor,
    setConnectionState,
    setPausedAt,
    setRecordingState,
    setTranslationEntry,
    updatePreview,
    updatePreviewTranslation,
  ]);

  // P1-4：录音中连接错误（自动重连已达上限、connectionState='error'）时，供 UI 提供独立的
  // 「重新连接」操作。归档 recorder 仍在采集，故不中断本地录音，仅重置重连计数并重新进入
  // 自动重连状态机（attemptReconnect），让实时转录重新连上。
  const reconnect = useCallback(() => {
    const state = useTranscriptStore.getState().recordingState;
    if (state !== 'recording' && state !== 'paused') {
      return;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
    shouldReconnectRef.current = true;
    void attemptReconnect();
  }, [attemptReconnect]);

  const getAudioBlob = useCallback(() => lastAudioBlobRef.current, []);

  return {
    start,
    stop,
    pause,
    switchMicrophone,
    rebuildSession,
    reconnectAfterRefresh,
    reconnect,
    getAudioBlob,
    syncRemoteDraft,
    finalizeRemoteDraft,
  };
}
