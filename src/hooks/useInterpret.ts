'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EMPTY_STREAMING_PREVIEW_TEXT,
  EMPTY_STREAMING_PREVIEW_TRANSLATION,
} from '@/lib/transcriptPreview';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  getAuthBoundaryAbortSignal,
  getAuthBoundarySnapshot,
  isAuthBoundaryCurrent,
  isPersistedAuthBoundaryCurrent,
  type AuthBoundarySnapshot,
  useAuthStore,
} from '@/stores/authStore';
import { runAuthBoundaryCommit } from '@/lib/clientAuthCookieMutation';
import { TokenProcessor } from '@/lib/soniox/tokenProcessor';
import { buildSonioxConfig, startSonioxRecording } from '@/lib/soniox/client';
import type { RealtimeToken } from '@/types/soniox';
import type {
  SessionConfig,
  StreamingPreviewText,
  StreamingPreviewTranslation,
  TranscriptSegment,
} from '@/types/transcript';

export interface InterpretLine {
  id: string;
  language: string;
  text: string;
  translatedText?: string;
  timestamp: string;
}

function upsertInterpretLine(
  lines: InterpretLine[],
  nextLine: InterpretLine
): InterpretLine[] {
  const existingIndex = lines.findIndex((line) => line.id === nextLine.id);
  if (existingIndex === -1) {
    return [...lines, nextLine];
  }

  const next = [...lines];
  next[existingIndex] = { ...next[existingIndex], ...nextLine };
  return next;
}

type RecordingHandle = {
  stop?: () => Promise<void> | void;
};

interface InterpretOwner {
  generation: number;
  boundary: AuthBoundarySnapshot;
  signal: AbortSignal;
}

// R1-L1：key 的 max_session_duration_seconds 到点 Soniox 硬断连接；提前这么多秒主动平滑轮换。
const ROTATION_LEAD_S = 30;

export function useInterpret() {
  const [isRunning, setIsRunning] = useState(false);
  const [connectionState, setConnectionState] = useState<string>('disconnected');
  const [linesA, setLinesA] = useState<InterpretLine[]>([]);
  const [linesB, setLinesB] = useState<InterpretLine[]>([]);
  const [previewText, setPreviewText] = useState<StreamingPreviewText>(
    EMPTY_STREAMING_PREVIEW_TEXT
  );
  const [previewTranslation, setPreviewTranslation] =
    useState<StreamingPreviewTranslation>(EMPTY_STREAMING_PREVIEW_TRANSLATION);
  const [previewLang, setPreviewLang] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const recordingRef = useRef<{ recording: RecordingHandle; client: unknown } | null>(null);
  // H3：同传的运行代次。start() 有两个 await 窗口（建锚点的 fetch、startSonioxRecording 的
  // mint key + WS 握手，合计可达数秒），窗口里点「停止」或导航离开时 stop()/卸载读到的
  // recordingRef 还是 null → 句柄相关全部 no-op，但照常结算扣费并置 isRunning(false)；随后
  // start 的后半段无条件把句柄/计时器/轮换定时器装回去，于是麦克风常亮、转录持续、**永不
  // 再计费**，而 scheduleRotation 建的轮换定时器每 ~15 分钟自我重建一条 Soniox 连接，孤儿
  // 自我续命。isStartingRef 那把重入锁只挡并发 start，挡不住 stop。
  // 不变式：stop() 与卸载清理在**任何 await 之前**同步 bump 本代次；start/rotate 的每个
  // await 之后都必须复查代次，过期即就地拆掉已经建起来的资源（停 WS、清定时器），绝不发布。
  const processorRef = useRef<TokenProcessor | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const anchorIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const langARef = useRef('en');
  const langBRef = useRef('zh');
  const previewLangRef = useRef<string | null>(null);
  // 同步重入保护：防止快速双击 start/stop 造成孤儿录音或双重扣费
  const isStartingRef = useRef(false);
  const isStoppingRef = useRef(false);
  // R1-L1：连接寿命轮换。key 的 max_session_duration_seconds（=服务端本次预扣分钟）到点
  // Soniox 硬断；提前主动优雅轮换（re-mint 新 key/新预扣接续本场）。重建连接复用 start 时的
  // 回调与 WS 配置（processor 延续、段落不断），锚点/计时器不动——仍是同一场同传。
  const rotationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rotateConnectionRef = useRef<() => void>(() => {});
  const sonioxConfigRef = useRef<ReturnType<typeof buildSonioxConfig> | null>(null);
  const callbacksRef = useRef<Parameters<typeof startSonioxRecording>[2] | null>(null);
  const deviceIdRef = useRef<string | undefined>(undefined);
  const lifecycleGenerationRef = useRef(0);
  const activeOwnerRef = useRef<InterpretOwner | null>(null);

  const ownerIsCurrent = useCallback((owner: InterpretOwner) => (
    lifecycleGenerationRef.current === owner.generation &&
    activeOwnerRef.current === owner &&
    !owner.signal.aborted &&
    isAuthBoundaryCurrent(owner.boundary) &&
    isPersistedAuthBoundaryCurrent(owner.boundary)
  ), []);

  const token = useAuthStore((s) => s.token);

  const deductQuota = useCallback(
    async (
      durationMs: number,
      anchorId: string | null,
      expected: AuthBoundarySnapshot
    ) => {
      if (
        !isAuthBoundaryCurrent(expected) ||
        !isPersistedAuthBoundaryCurrent(expected)
      ) {
        return;
      }
      const authToken = useAuthStore.getState().token;
      // 有服务端锚点时即使前端时长为 0 也要让服务端按墙钟结算；无锚点才依赖 durationMs
      if (!authToken || (durationMs <= 0 && !anchorId)) return;
      try {
        const res = await fetch('/api/interpret/deduct', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ durationMs, translationMode: 'soniox', anchorId }),
        });
        if (res.ok) {
          const data = (await res.json()) as { quotas?: Record<string, unknown> };
          if (data.quotas) {
            await runAuthBoundaryCommit(expected, () => {
              useAuthStore
                .getState()
                .setQuotas(data.quotas as never, { expected });
            });
          }
        }
      } catch (e) {
        console.error('Failed to deduct interpret quota:', e);
      }
    },
    []
  );

  // R1-L1：安排寿命轮换（稳定引用，经 rotateConnectionRef 中转避免 useCallback 环）。
  const scheduleRotation = useCallback((maxSessionSeconds?: number) => {
    if (rotationTimerRef.current) {
      clearTimeout(rotationTimerRef.current);
      rotationTimerRef.current = null;
    }
    // 收缩到极短（额度尾巴）不轮换：让 Soniox 硬断兜底，重启会因额度耗尽被 mint 403 明确拒绝。
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

  // R1-L1：主动平滑轮换——优雅停旧连接（final flush 仍进同一 processor，段落不断），随即用
  // start 时存下的同一套回调/配置重新建连（re-mint：服务端新预扣、新 grant，anchorId 不变仍
  // 关联本场锚点）。失败置 error（与断线同表现，用户可停止结算或重开）。
  const rotateConnection = useCallback(() => {
    void (async () => {
      const owner = activeOwnerRef.current;
      const current = recordingRef.current;
      const callbacks = callbacksRef.current;
      const sonioxConfig = sonioxConfigRef.current;
      const authToken = useAuthStore.getState().token;
      if (
        !owner ||
        !ownerIsCurrent(owner) ||
        !current ||
        !callbacks ||
        !sonioxConfig ||
        !authToken
      ) {
        return;
      }
      recordingRef.current = null;
      try {
        await current.recording.stop?.();
      } catch (e) {
        console.error('Interpret rotation: error stopping old connection:', e);
      }
      // stop 之后用户可能已同时点了停止（isStoppingRef/句柄已清）——不再重建
      if (
        !ownerIsCurrent(owner) ||
        isStoppingRef.current ||
        !startTimeRef.current
      ) {
        return;
      }
      try {
        const settings = useSettingsStore.getState();
        const result = await startSonioxRecording(sonioxConfig, authToken, callbacks, {
          sourceType: 'mic',
          deviceId: deviceIdRef.current,
          regionPreference: settings.sonioxRegionPreference,
          attribution: { kind: 'interpret', anchorId: anchorIdRef.current },
          signal: owner.signal,
        });
        if (
          !ownerIsCurrent(owner) ||
          isStoppingRef.current ||
          !startTimeRef.current
        ) {
          // 轮换建连期间被停止：立刻拆掉刚建的连接，不留孤儿流
          try {
            await (result as { recording: RecordingHandle }).recording.stop?.();
          } catch { /* silent */ }
          return;
        }
        recordingRef.current = result as { recording: RecordingHandle; client: unknown };
        scheduleRotation(result.temporaryKey?.max_session_duration_seconds);
      } catch (error) {
        console.error('Interpret rotation failed:', error);
        if (ownerIsCurrent(owner)) setConnectionState('error');
      }
    })();
  }, [ownerIsCurrent, scheduleRotation]);

  useEffect(() => {
    rotateConnectionRef.current = rotateConnection;
  }, [rotateConnection]);

  const start = useCallback(
    async (langA: string, langB: string, deviceId?: string) => {
      if (!token) return;
      // U27：同步重入保护，快速双击不会派生两条 Soniox WS / 两路麦克风
      if (isStartingRef.current || isStoppingRef.current || recordingRef.current) return;
      isStartingRef.current = true;
      const owner: InterpretOwner = {
        generation: lifecycleGenerationRef.current + 1,
        boundary: getAuthBoundarySnapshot(),
        signal: getAuthBoundaryAbortSignal(),
      };
      lifecycleGenerationRef.current = owner.generation;
      activeOwnerRef.current = owner;

      langARef.current = langA;
      langBRef.current = langB;

      // 构建 two_way 配置
      const settings = useSettingsStore.getState();
      const baseConfig: SessionConfig = {
        model: 'stt-rt-v4',
        sourceLang: langA,
        targetLang: langB,
        languageHints: [langA, langB],
        enableSpeakerDiarization: false,
        enableLanguageIdentification: true,
        enableEndpointDetection: true,
        endpointDetectionMs: settings.endpointDetectionMs,
        translationMode: 'soniox',
        domain: '',
        topic: '',
        terms: [],
        sonioxRegionPreference: settings.sonioxRegionPreference,
        clientReferenceId: `interpret:${langA}:${langB}`,
        twoWayTranslation: true,
      };

      const sonioxConfig = buildSonioxConfig(baseConfig);

      // 创建 TokenProcessor
      const processor = new TokenProcessor({
        onSegmentFinalized: (segment: TranscriptSegment) => {
          if (!ownerIsCurrent(owner)) return;
          const line: InterpretLine = {
            id: segment.id,
            language: segment.language,
            text: segment.text,
            timestamp: segment.timestamp,
          };

          // 根据语言分流到 A 或 B 面板
          const isLangA = segment.language === langARef.current;
          if (isLangA) {
            setLinesA((prev) => [...prev, line]);
          } else {
            setLinesB((prev) => [...prev, line]);
          }

          setPreviewText(EMPTY_STREAMING_PREVIEW_TEXT);
          setPreviewTranslation(EMPTY_STREAMING_PREVIEW_TRANSLATION);
          setPreviewLang(null);
          previewLangRef.current = null;
        },
        onPreviewUpdate: (preview) => {
          if (!ownerIsCurrent(owner)) return;
          setPreviewText(preview);
        },
        onTranslationToken: (text: string, segmentId: string, meta) => {
          if (!ownerIsCurrent(owner)) return;
          const sourceLanguage = meta?.sourceLanguage ?? previewLangRef.current;
          const isLangA = sourceLanguage === langARef.current;
          const translatedLineId = `${segmentId}-tr`;
          const translatedLine: InterpretLine = {
            id: translatedLineId,
            language: '',
            text,
            timestamp: '',
          };

          const upsertTranslatedLine = (lines: InterpretLine[]) => {
            if (!text.trim()) {
              return lines.filter((line) => line.id !== translatedLineId);
            }
            return upsertInterpretLine(lines, translatedLine);
          };

          const patchOriginalLine = (lines: InterpretLine[]) =>
            lines.map((line) =>
              line.id === segmentId
                ? { ...line, translatedText: text || undefined }
                : line
            );

          if (isLangA) {
            setLinesB(upsertTranslatedLine);
            setLinesA(patchOriginalLine);
          } else {
            setLinesA(upsertTranslatedLine);
            setLinesB(patchOriginalLine);
          }
        },
        onPreviewTranslationUpdate: (preview) => {
          if (!ownerIsCurrent(owner)) return;
          setPreviewTranslation(preview);
        },
      });
      // 双向同传：告知 TokenProcessor 语言对，使每段目标语言按方向解析
      // （A→B 目标 langB、B→A 目标 langA）。否则 targetLang 恒为 ''，
      // 「翻译中…」等待指示器永远是死分支。
      processor.setLanguagePair(langA, langB);
      processorRef.current = processor;

      // 建立服务端时长锚点（反作弊：deduct 以服务端墙钟为计费权威）。
      // 失败不阻塞 interpret 启动，deduct 会降级信任前端时长。
      anchorIdRef.current = null;
      let anchorId: string | null = null;
      try {
        const anchorRes = await fetch('/api/interpret/start', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        });
        if (anchorRes.ok) {
          const anchorData = (await anchorRes.json()) as { anchorId?: string | null };
          anchorId = anchorData.anchorId ?? null;
        }
      } catch {
        // 锚点是计费增强项，建立失败时静默降级
      }

      if (!ownerIsCurrent(owner)) {
        if (processorRef.current === processor) processorRef.current = null;
        if (activeOwnerRef.current === owner) activeOwnerRef.current = null;
        isStartingRef.current = false;
        // H3 窗口①：stop()/卸载落在建锚点的 fetch 期间。此时 stop 读到的 startTimeRef 与
        // recordingRef 都还是 null（duration=0、无句柄），扣费与句柄清理全是 no-op。
        // 这里把刚建好的服务端锚点顺手结算掉（durationMs=0 + anchorId → 服务端按墙钟
        // ≈0 结算并消费 Redis 锚点），免得它悬挂到 cron 7h 兜底。
        if (anchorId) {
          void deductQuota(0, anchorId, owner.boundary);
        }
        return;
      }
      anchorIdRef.current = anchorId;

      // 计时器
      startTimeRef.current = Date.now();
      setElapsedMs(0);
      timerRef.current = setInterval(() => {
        if (startTimeRef.current) {
          setElapsedMs(Date.now() - startTimeRef.current);
        }
      }, 1000);

      setLinesA([]);
      setLinesB([]);
      setIsRunning(true);
      setConnectionState('connecting');

      // 回调与配置存 ref：寿命轮换（rotateConnection）重建连接时原样复用——processor 延续、
      // 段落不断，锚点/计时器不动，仍是同一场同传。
      // H3：回调全部带代次门闩。孤儿连接（stop 之后才 open 的 WS、或拆连接期间迟到的帧）
      // 不得再回写 UI —— 否则「已停止」的界面会被重新点亮成 connected/出字。轮换重建连接时
      // 复用同一套回调，而轮换不 bump 代次，故门闩对同一场同传恒成立。
      const callbacks: Parameters<typeof startSonioxRecording>[2] = {
        onPartialResult: (tokens) => {
          if (!ownerIsCurrent(owner)) return;
          const rtTokens = tokens as RealtimeToken[];
          // 原文 preview 侧仍基于当前转录 token 的 language 判断
          for (const t of rtTokens) {
            if (t.translation_status !== 'translation' && t.language) {
              setPreviewLang(t.language);
              previewLangRef.current = t.language;
            }
          }
          processor.processTokens(rtTokens);
        },
        onEndpoint: () => {
          if (!ownerIsCurrent(owner)) return;
          processor.onEndpoint();
        },
        onError: (error) => {
          if (!ownerIsCurrent(owner)) return;
          console.error('Interpret Soniox error:', error);
          setConnectionState('error');
        },
        onConnectionChange: (state) => {
          if (!ownerIsCurrent(owner)) return;
          setConnectionState(state);
        },
      };
      callbacksRef.current = callbacks;
      sonioxConfigRef.current = sonioxConfig;
      deviceIdRef.current = deviceId || undefined;

      try {
        const result = await startSonioxRecording(
          sonioxConfig,
          token,
          callbacks,
          {
            // U25：同传恒为麦克风采集，用页面传入的 deviceId；
            // 不复用讲座页持久化的 audioSource（可能是 'system'）或 preferredMicDeviceId。
            sourceType: 'mic',
            deviceId: deviceId || undefined,
            regionPreference: settings.sonioxRegionPreference,
            attribution: { kind: 'interpret', anchorId: anchorIdRef.current },
            signal: owner.signal,
          }
        );

        if (!ownerIsCurrent(owner) || isStoppingRef.current) {
          try {
            await (result as { recording: RecordingHandle }).recording.stop?.();
          } catch { /* stale capability teardown is best effort */ }
          return;
        }
        recordingRef.current = result as { recording: RecordingHandle; client: unknown };
        scheduleRotation(result.temporaryKey?.max_session_duration_seconds);
      } catch (error) {
        if (ownerIsCurrent(owner)) {
          console.error('Failed to start interpret:', error);
          setIsRunning(false);
          setConnectionState('error');
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          // 启动失败：清空计时基准，避免残留的 startTimeRef 让后续 stop 误计费
          startTimeRef.current = null;
        }
      } finally {
        if (
          activeOwnerRef.current === owner ||
          activeOwnerRef.current === null
        ) {
          isStartingRef.current = false;
        }
      }
    },
    [token, ownerIsCurrent, scheduleRotation, deductQuota]
  );

  const stop = useCallback(async () => {
    // U26：同步重入保护，快速双击停止不会重复消费锚点/降级扣费两次。
    // 计时基准、锚点、录音句柄都在任何 await 之前同步取出并清空，
    // 保证 deductQuota 对同一场同传至多以同一口径调用一次。
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;
    const owner = activeOwnerRef.current;
    const expected = owner?.boundary ?? getAuthBoundarySnapshot();
    lifecycleGenerationRef.current += 1;
    activeOwnerRef.current = null;

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    // 本场结束：寿命轮换作废（下一场 start 会重新 schedule）
    if (rotationTimerRef.current) {
      clearTimeout(rotationTimerRef.current);
      rotationTimerRef.current = null;
    }
    callbacksRef.current = null;
    sonioxConfigRef.current = null;

    const duration = startTimeRef.current ? Date.now() - startTimeRef.current : 0;
    startTimeRef.current = null;

    // 停止录音
    const current = recordingRef.current;
    recordingRef.current = null;
    try {
      await current?.recording.stop?.();
    } catch (e) {
      console.error('Error stopping interpret recording:', e);
    }

    // flush 最后一个 segment
    processorRef.current?.onEndpoint();
    processorRef.current = null;

    const boundaryStillCurrent =
      isAuthBoundaryCurrent(expected) &&
      isPersistedAuthBoundaryCurrent(expected);
    if (boundaryStillCurrent) {
      setIsRunning(false);
      setConnectionState('disconnected');
      setPreviewText(EMPTY_STREAMING_PREVIEW_TEXT);
      setPreviewTranslation(EMPTY_STREAMING_PREVIEW_TRANSLATION);
      setPreviewLang(null);
      previewLangRef.current = null;
    }

    // 扣除配额：带上服务端锚点 id，由服务端以墙钟为权威结算
    const anchorId = anchorIdRef.current;
    anchorIdRef.current = null;
    if (boundaryStillCurrent && (duration > 0 || anchorId)) {
      void deductQuota(duration, anchorId, expected);
    }

    // 释放重入锁，允许下一场同传重新开始/停止
    isStoppingRef.current = false;
  }, [deductQuota]);

  // C7：组件卸载（如 SPA 导航离开 /interpret）时拆掉进行中的录音并触发扣费，
  // 否则孤儿 Soniox WS + 麦克风会一直运行且整场同传不计费。
  // 用 ref 持有最新 stop，effect 依赖为空只在卸载时执行一次。
  useEffect(() => {
    const invalidateAndTeardown = (updateState: boolean) => {
      // C7：拆场前先取结算所需的三样东西（下面会把它们全清掉）。
      const settleBoundary =
        activeOwnerRef.current?.boundary ?? getAuthBoundarySnapshot();
      const settleAnchorId = anchorIdRef.current;
      const settleDurationMs = startTimeRef.current
        ? Date.now() - startTimeRef.current
        : 0;
      lifecycleGenerationRef.current += 1;
      activeOwnerRef.current = null;
      isStartingRef.current = false;
      isStoppingRef.current = false;
      callbacksRef.current = null;
      sonioxConfigRef.current = null;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (rotationTimerRef.current) {
        clearTimeout(rotationTimerRef.current);
        rotationTimerRef.current = null;
      }
      const current = recordingRef.current;
      recordingRef.current = null;
      processorRef.current = null;
      startTimeRef.current = null;
      anchorIdRef.current = null;
      try {
        void Promise.resolve(current?.recording.stop?.()).catch(() => undefined);
      } catch { /* teardown must remain synchronous at the boundary */ }
      if (updateState) {
        setIsRunning(false);
        setConnectionState('disconnected');
        setPreviewText(EMPTY_STREAMING_PREVIEW_TEXT);
        setPreviewTranslation(EMPTY_STREAMING_PREVIEW_TRANSLATION);
        setPreviewLang(null);
        previewLangRef.current = null;
      }
      // C7：注释一直承诺「卸载时触发扣费」，但重写后这条路径不再结算 —— 锚点会一直
      // 悬挂到 cron 7h 兜底。这里补回：账号已切走时 deductQuota 内部的边界校验会自行
      // 早退，不会把上一位用户的时长记到新主体头上。
      if (settleAnchorId || settleDurationMs > 0) {
        void deductQuota(settleDurationMs, settleAnchorId, settleBoundary);
      }
    };
    const clearForBoundary = () => invalidateAndTeardown(true);
    window.addEventListener(
      'lecture-live:account-boundary-clear',
      clearForBoundary
    );
    return () => {
      window.removeEventListener(
        'lecture-live:account-boundary-clear',
        clearForBoundary
      );
      invalidateAndTeardown(false);
    };
  }, [deductQuota]);

  return {
    isRunning,
    connectionState,
    linesA,
    linesB,
    previewText,
    previewTranslation,
    previewLang,
    elapsedMs,
    start,
    stop,
  };
}
