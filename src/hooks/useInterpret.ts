'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EMPTY_STREAMING_PREVIEW_TEXT,
  EMPTY_STREAMING_PREVIEW_TRANSLATION,
} from '@/lib/transcriptPreview';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAuthStore } from '@/stores/authStore';
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

  const token = useAuthStore((s) => s.token);

  const deductQuota = useCallback(
    async (durationMs: number, anchorId: string | null) => {
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
            useAuthStore.getState().setQuotas(data.quotas as never);
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
      const current = recordingRef.current;
      const callbacks = callbacksRef.current;
      const sonioxConfig = sonioxConfigRef.current;
      const authToken = useAuthStore.getState().token;
      if (!current || !callbacks || !sonioxConfig || !authToken) {
        return;
      }
      recordingRef.current = null;
      try {
        await current.recording.stop?.();
      } catch (e) {
        console.error('Interpret rotation: error stopping old connection:', e);
      }
      // stop 之后用户可能已同时点了停止（isStoppingRef/句柄已清）——不再重建
      if (isStoppingRef.current || !startTimeRef.current) {
        return;
      }
      try {
        const settings = useSettingsStore.getState();
        const result = await startSonioxRecording(sonioxConfig, authToken, callbacks, {
          sourceType: 'mic',
          deviceId: deviceIdRef.current,
          regionPreference: settings.sonioxRegionPreference,
          attribution: { kind: 'interpret', anchorId: anchorIdRef.current },
        });
        if (isStoppingRef.current || !startTimeRef.current) {
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
        setConnectionState('error');
      }
    })();
  }, [scheduleRotation]);

  useEffect(() => {
    rotateConnectionRef.current = rotateConnection;
  }, [rotateConnection]);

  const start = useCallback(
    async (langA: string, langB: string, deviceId?: string) => {
      if (!token) return;
      // U27：同步重入保护，快速双击不会派生两条 Soniox WS / 两路麦克风
      if (isStartingRef.current || recordingRef.current) return;
      isStartingRef.current = true;

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
          setPreviewText(preview);
        },
        onTranslationToken: (text: string, segmentId: string, meta) => {
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
          anchorIdRef.current = anchorData.anchorId ?? null;
        }
      } catch {
        // 锚点是计费增强项，建立失败时静默降级
      }

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
      const callbacks: Parameters<typeof startSonioxRecording>[2] = {
        onPartialResult: (tokens) => {
          const rtTokens = tokens as RealtimeToken[];
          // 原文 preview 侧仍基于当前转录 token 的 language 判断
          for (const t of rtTokens) {
            if (t.translation_status !== 'translation' && t.language) {
              setPreviewLang(t.language);
              previewLangRef.current = t.language;
            }
          }
          processorRef.current?.processTokens(rtTokens);
        },
        onEndpoint: () => {
          processorRef.current?.onEndpoint();
        },
        onError: (error) => {
          console.error('Interpret Soniox error:', error);
          setConnectionState('error');
        },
        onConnectionChange: (state) => {
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
          }
        );

        recordingRef.current = result as { recording: RecordingHandle; client: unknown };
        scheduleRotation(result.temporaryKey?.max_session_duration_seconds);
      } catch (error) {
        console.error('Failed to start interpret:', error);
        setIsRunning(false);
        setConnectionState('error');
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        // 启动失败：清空计时基准，避免残留的 startTimeRef 让后续 stop 误计费
        startTimeRef.current = null;
      } finally {
        isStartingRef.current = false;
      }
    },
    [token, scheduleRotation]
  );

  const stop = useCallback(async () => {
    // U26：同步重入保护，快速双击停止不会重复消费锚点/降级扣费两次。
    // 计时基准、锚点、录音句柄都在任何 await 之前同步取出并清空，
    // 保证 deductQuota 对同一场同传至多以同一口径调用一次。
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;

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

    setIsRunning(false);
    setConnectionState('disconnected');
    setPreviewText(EMPTY_STREAMING_PREVIEW_TEXT);
    setPreviewTranslation(EMPTY_STREAMING_PREVIEW_TRANSLATION);
    setPreviewLang(null);
    previewLangRef.current = null;

    // 扣除配额：带上服务端锚点 id，由服务端以墙钟为权威结算
    const anchorId = anchorIdRef.current;
    anchorIdRef.current = null;
    if (duration > 0 || anchorId) {
      void deductQuota(duration, anchorId);
    }

    // 释放重入锁，允许下一场同传重新开始/停止
    isStoppingRef.current = false;
  }, [deductQuota]);

  // C7：组件卸载（如 SPA 导航离开 /interpret）时拆掉进行中的录音并触发扣费，
  // 否则孤儿 Soniox WS + 麦克风会一直运行且整场同传不计费。
  // 用 ref 持有最新 stop，effect 依赖为空只在卸载时执行一次。
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        void stopRef.current();
      }
    };
  }, []);

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
