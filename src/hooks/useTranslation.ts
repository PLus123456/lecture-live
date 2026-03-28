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
      setLocalModelStatus('Failed to load model');
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
