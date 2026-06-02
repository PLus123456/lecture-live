'use client';

import { useRef, useCallback } from 'react';
import { useTranslationStore } from '@/stores/translationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { TranslationScheduler } from '@/lib/translation/scheduler';

export function useLocalTranslation() {
  const schedulerRef = useRef<TranslationScheduler | null>(null);
  const setTranslation = useTranslationStore((s) => s.setTranslation);
  const setLocalModelLoaded = useTranslationStore((s) => s.setLocalModelLoaded);
  const setLocalModelProgress = useTranslationStore((s) => s.setLocalModelProgress);
  const setLocalModelStatus = useTranslationStore((s) => s.setLocalModelStatus);

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
