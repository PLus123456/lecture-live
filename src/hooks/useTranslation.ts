'use client';

import { useRef, useCallback } from 'react';
import { useTranslationStore } from '@/stores/translationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { TranslationScheduler } from '@/lib/translation/scheduler';

export function useLocalTranslation(options?: {
  /**
   * 本地模型加载失败、自动回退到云端（'soniox'）翻译时触发。
   * 用于让上层把进行中的 Soniox 会话按新翻译配置重建（否则活跃会话的
   * translation config 在连接时已固定、之后不再更新，回退后仍零翻译）。U81
   */
  onFallbackToCloud?: () => void;
}) {
  const schedulerRef = useRef<TranslationScheduler | null>(null);
  const setTranslation = useTranslationStore((s) => s.setTranslation);
  const setLocalModelLoaded = useTranslationStore((s) => s.setLocalModelLoaded);
  const setLocalModelProgress = useTranslationStore((s) => s.setLocalModelProgress);
  const setLocalModelStatus = useTranslationStore((s) => s.setLocalModelStatus);

  // 用 ref 持有回调，避免其 identity 变化把 initLocal 依赖打散（initLocal 被上层
  // effect 依赖，频繁重建会触发本地翻译器反复销毁重建）。
  const onFallbackToCloudRef = useRef(options?.onFallbackToCloud);
  onFallbackToCloudRef.current = options?.onFallbackToCloud;

  const initLocal = useCallback(async () => {
    const { sourceLang, targetLang } = useSettingsStore.getState();

    const scheduler = new TranslationScheduler({
      onLocalTranslationResult: (results) => {
        for (const r of results) {
          setTranslation(r.segmentId, r.translation);
        }
      },
      onModelProgress: (progress, status) => {
        setLocalModelProgress(progress);
        setLocalModelStatus(status);
      },
      onModelLoaded: () => {
        setLocalModelLoaded(true);
        setLocalModelStatus('Model ready');
      },
    });

    // 设置目标语言，用于同语言 passthrough
    scheduler.setTargetLang(targetLang);
    schedulerRef.current = scheduler;

    try {
      await scheduler.initLocalTranslator(sourceLang, targetLang);
    } catch (error) {
      console.error('Failed to initialize local translator:', error);
      setLocalModelStatus('Failed to load model — falling back to cloud');
      // 本地模型加载失败时回退到云端翻译，避免“零翻译”。
      // 切到 'soniox' 后：① buildSonioxConfig 会重新发 Soniox 云翻译；
      // ② 上层 effect 依赖 translationMode，会停掉本地引擎（不再重试本地）。
      const { translationMode, setTranslationMode } = useSettingsStore.getState();
      if (translationMode !== 'soniox') {
        setTranslationMode('soniox');
        // 仅改 translationMode 不会让已连接的 Soniox 会话启用云翻译——其 translation
        // config 在连接时固定、之后不更新。触发上层按新配置重建活跃会话，否则回退后
        // 剩余段落仍永久卡在 translating…（U81）。rebuildSession 无活跃会话时自会早退。
        onFallbackToCloudRef.current?.();
      }
    }
  }, [setTranslation, setLocalModelLoaded, setLocalModelProgress, setLocalModelStatus]);

  const translateSentence = useCallback(
    (segmentId: string, text: string, segmentLang?: string) => {
      schedulerRef.current?.onFinalizedSentence(segmentId, text, segmentLang);
    },
    []
  );

  const destroy = useCallback(() => {
    schedulerRef.current?.destroy();
    schedulerRef.current = null;
  }, []);

  return { initLocal, translateSentence, destroy };
}
