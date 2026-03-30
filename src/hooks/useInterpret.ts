'use client';

import { useCallback, useRef, useState } from 'react';
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
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const langARef = useRef('en');
  const langBRef = useRef('zh');
  const previewLangRef = useRef<string | null>(null);

  const token = useAuthStore((s) => s.token);

  const deductQuota = useCallback(
    async (durationMs: number) => {
      const authToken = useAuthStore.getState().token;
      if (!authToken || durationMs <= 0) return;
      try {
        const res = await fetch('/api/interpret/deduct', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ durationMs, translationMode: 'soniox' }),
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

  const start = useCallback(
    async (langA: string, langB: string) => {
      if (!token) return;

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
      processorRef.current = processor;

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

      try {
        const result = await startSonioxRecording(
          sonioxConfig,
          token,
          {
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
          },
          {
            sourceType: settings.audioSource,
            deviceId:
              settings.audioSource === 'mic'
                ? settings.preferredMicDeviceId
                : undefined,
            regionPreference: settings.sonioxRegionPreference,
            clientReferenceId: `interpret:${langA}:${langB}`,
          }
        );

        recordingRef.current = result as { recording: RecordingHandle; client: unknown };
      } catch (error) {
        console.error('Failed to start interpret:', error);
        setIsRunning(false);
        setConnectionState('error');
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      }
    },
    [token]
  );

  const stop = useCallback(async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const duration = startTimeRef.current ? Date.now() - startTimeRef.current : 0;

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

    // 扣除配额
    if (duration > 0) {
      void deductQuota(duration);
    }
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
