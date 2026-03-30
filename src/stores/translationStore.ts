'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { createSegmentTranslationEntry } from '@/lib/transcriptPreview';
import type {
  SegmentTranslationEntry,
  SegmentTranslationState,
  TranslationMode,
} from '@/types/transcript';

interface TranslationStore {
  translations: Record<string, string>; // segmentId → translated text
  translationEntries: Record<string, SegmentTranslationEntry>;
  mode: TranslationMode;
  localModelLoaded: boolean;
  localModelProgress: number;
  localModelStatus: string;

  setTranslation: (
    segmentId: string,
    text: string,
    options?: {
      state?: SegmentTranslationState;
      sourceLanguage?: string | null;
    }
  ) => void;
  setTranslationEntry: (segmentId: string, entry: SegmentTranslationEntry) => void;
  setMode: (mode: TranslationMode) => void;
  setLocalModelLoaded: (loaded: boolean) => void;
  setLocalModelProgress: (progress: number) => void;
  setLocalModelStatus: (status: string) => void;
  clearAll: () => void;
}

export const useTranslationStore = create<TranslationStore>()(
  persist(
    (set) => ({
      translations: {},
      translationEntries: {},
      mode: 'soniox',
      localModelLoaded: false,
      localModelProgress: 0,
      localModelStatus: '',

      setTranslation: (segmentId, text, options) =>
        set((state) => ({
          translations: { ...state.translations, [segmentId]: text },
          translationEntries: {
            ...state.translationEntries,
            [segmentId]: createSegmentTranslationEntry(
              text,
              options?.state ?? 'final',
              options?.sourceLanguage ?? state.translationEntries[segmentId]?.sourceLanguage ?? null
            ),
          },
        })),

      setTranslationEntry: (segmentId, entry) =>
        set((state) => ({
          translations: { ...state.translations, [segmentId]: entry.text },
          translationEntries: { ...state.translationEntries, [segmentId]: entry },
        })),

      setMode: (mode) => set({ mode }),

      setLocalModelLoaded: (loaded) => set({ localModelLoaded: loaded }),

      setLocalModelProgress: (progress) => set({ localModelProgress: progress }),

      setLocalModelStatus: (status) => set({ localModelStatus: status }),

      clearAll: () =>
        set({
          translations: {},
          translationEntries: {},
          localModelLoaded: false,
          localModelProgress: 0,
          localModelStatus: '',
        }),
    }),
    {
      name: 'lecture-live-translations',
      storage: createJSONStorage(() => sessionStorage),
      // 只持久化翻译数据，不持久化本地模型状态
      partialize: (state) => ({
        translations: state.translations,
        translationEntries: state.translationEntries,
      }),
      merge: (persisted, current) => {
        const persistedState = (persisted ?? {}) as Partial<TranslationStore>;
        const translations =
          persistedState.translations && typeof persistedState.translations === 'object'
            ? persistedState.translations
            : current.translations;
        const translationEntries =
          persistedState.translationEntries && typeof persistedState.translationEntries === 'object'
            ? persistedState.translationEntries
            : Object.fromEntries(
                Object.entries(translations).map(([segmentId, text]) => [
                  segmentId,
                  createSegmentTranslationEntry(text, 'final', null),
                ])
              );

        return {
          ...current,
          ...persistedState,
          translations,
          translationEntries,
        };
      },
    }
  )
);
