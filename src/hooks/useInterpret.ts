'use client';

import { useCallback, useRef, useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAuthStore } from '@/stores/authStore';
import { TokenProcessor } from '@/lib/soniox/tokenProcessor';
import { buildSonioxConfig, startSonioxRecording } from '@/lib/soniox/client';
import type { RealtimeToken } from '@/types/soniox';
import type { TranscriptSegment, SessionConfig } from '@/types/transcript';

export interface InterpretLine {
  id: string;
  language: string;
  text: string;
  translatedText?: string;
  timestamp: string;
}

type RecordingHandle = {
  stop?: () => Promise<void> | void;
};

export function useInterpret() {
  const [isRunning, setIsRunning] = useState(false);
  const [connectionState, setConnectionState] = useState<string>('disconnected');
  const [linesA, setLinesA] = useState<InterpretLine[]>([]);
  const [linesB, setLinesB] = useState<InterpretLine[]>([]);
  const [previewText, setPreviewText] = useState('');
  const [previewTranslation, setPreviewTranslation] = useState('');
  const [previewLang, setPreviewLang] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const recordingRef = useRef<{ recording: RecordingHandle; client: unknown } | null>(null);
  const processorRef = useRef<TokenProcessor | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const langARef = useRef('en');
  const langBRef = useRef('zh');
  // 追踪当前正在说的语言（基于最近的 transcription token）
  const currentSpokenLangRef = useRef<string | null>(null);

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
          body: JSON.stringify({ durationMs }),
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
      currentSpokenLangRef.current = null;

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

          setPreviewText('');
          setPreviewTranslation('');
          setPreviewLang(null);
        },
        onPreviewUpdate: (text: string) => {
          setPreviewText(text);
        },
        onTranslationToken: (text: string, segmentId: string) => {
          // 翻译完成后绑定到对应 segment
          const translatedLine: InterpretLine = {
            id: `${segmentId}-tr`,
            language: '',
            text,
            timestamp: '',
          };

          // 翻译内容放到另一个面板
          const spokenLang = currentSpokenLangRef.current;
          const isLangA = spokenLang === langARef.current;
          if (isLangA) {
            // 说的是 A，翻译放到 B 面板
            setLinesB((prev) => [...prev, translatedLine]);
            // 同时更新 A 面板最后一个 line 的 translatedText
            setLinesA((prev) => {
              if (prev.length === 0) return prev;
              const last = prev[prev.length - 1];
              if (last.id === segmentId) {
                return [...prev.slice(0, -1), { ...last, translatedText: text }];
              }
              return prev;
            });
          } else {
            // 说的是 B，翻译放到 A 面板
            setLinesA((prev) => [...prev, translatedLine]);
            setLinesB((prev) => {
              if (prev.length === 0) return prev;
              const last = prev[prev.length - 1];
              if (last.id === segmentId) {
                return [...prev.slice(0, -1), { ...last, translatedText: text }];
              }
              return prev;
            });
          }
        },
        onPreviewTranslationUpdate: (text: string) => {
          setPreviewTranslation(text);
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
              // 追踪当前说的语言（从 transcription token 中获取）
              for (const t of rtTokens) {
                if (t.translation_status !== 'translation' && t.language) {
                  currentSpokenLangRef.current = t.language;
                  setPreviewLang(t.language);
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
    setPreviewText('');
    setPreviewTranslation('');
    setPreviewLang(null);

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
