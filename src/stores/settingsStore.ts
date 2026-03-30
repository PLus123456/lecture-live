'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  TranslationMode,
  SessionConfig,
  AudioSourceType,
  SonioxRegionPreference,
} from '@/types/transcript';

interface SettingsStore {
  // Language
  sourceLang: string;
  targetLang: string;
  languageHints: string[];

  // Translation
  translationMode: TranslationMode;

  // Audio
  audioSource: AudioSourceType;
  preferredMicDeviceId: string | null;

  // ASR
  enableSpeakerDiarization: boolean;
  enableLanguageIdentification: boolean;
  enableEndpointDetection: boolean;
  endpointDetectionMs: number;
  sonioxRegionPreference: SonioxRegionPreference;

  // Domain context
  domain: string;
  topic: string;
  terms: string[];

  // LLM summary
  llmProvider: string;
  summaryTriggerSentences: number;
  summaryTriggerMinutes: number;
  summaryLanguage: string;

  // Transcript
  /** 段落截断高度比例（0 表示禁用，0.1~0.5 对应面板可视区域百分比） */
  segmentSplitRatio: number;

  // UI
  sidebarCollapsed: boolean;
  userSettingsOpen: boolean;

  // Auto-start flag: set by setup page, consumed by session page
  pendingAutoStart: boolean;

  // Pre-acquired system audio stream (not persisted)
  pendingSystemStream: MediaStream | null;
  pendingSessionId: string | null;
  pendingSessionTerms: string[] | null;

  // Actions
  setPendingAutoStart: (v: boolean) => void;
  setPendingSystemStream: (stream: MediaStream | null) => void;
  consumePendingSystemStream: () => MediaStream | null;
  setPendingSessionTerms: (sessionId: string, terms: string[]) => void;
  clearPendingSessionTerms: () => void;
  setSourceLang: (lang: string) => void;
  setTargetLang: (lang: string) => void;
  setLanguageHints: (hints: string[]) => void;
  setTranslationMode: (mode: TranslationMode) => void;
  setAudioSource: (source: AudioSourceType) => void;
  setPreferredMicDeviceId: (deviceId: string | null) => void;
  setSonioxRegionPreference: (region: SonioxRegionPreference) => void;
  setDomain: (domain: string) => void;
  setTopic: (topic: string) => void;
  setTerms: (terms: string[]) => void;
  setLlmProvider: (provider: string) => void;
  setSummaryTriggerSentences: (count: number) => void;
  setSummaryTriggerMinutes: (minutes: number) => void;
  setSummaryLanguage: (language: string) => void;
  setSegmentSplitRatio: (ratio: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setUserSettingsOpen: (open: boolean) => void;
  getSessionConfig: (sessionId?: string) => SessionConfig;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      sourceLang: 'en',
      targetLang: 'zh',
      languageHints: ['en'],
      translationMode: 'soniox',
      audioSource: 'mic',
      preferredMicDeviceId: null,
      enableSpeakerDiarization: true,
      enableLanguageIdentification: true,
      enableEndpointDetection: true,
      endpointDetectionMs: 2000,
      sonioxRegionPreference: 'auto',
      domain: 'University Lecture',
      topic: '',
      terms: [],
      llmProvider: '',
      summaryTriggerSentences: 12,
      summaryTriggerMinutes: 3,
      summaryLanguage: 'zh',
      segmentSplitRatio: 0.25,
      sidebarCollapsed: false,
      userSettingsOpen: false,
      pendingAutoStart: false,
      pendingSystemStream: null,
      pendingSessionId: null,
      pendingSessionTerms: null,

      setPendingAutoStart: (pendingAutoStart) => set({ pendingAutoStart }),
      setPendingSystemStream: (pendingSystemStream) => set({ pendingSystemStream }),
      consumePendingSystemStream: () => {
        const stream = get().pendingSystemStream;
        if (stream) set({ pendingSystemStream: null });
        return stream;
      },
      setPendingSessionTerms: (pendingSessionId, pendingSessionTerms) =>
        set({ pendingSessionId, pendingSessionTerms }),
      clearPendingSessionTerms: () =>
        set({ pendingSessionId: null, pendingSessionTerms: null }),
      setSourceLang: (sourceLang) => set({ sourceLang }),
      setTargetLang: (targetLang) => set({ targetLang }),
      setLanguageHints: (languageHints) => set({ languageHints }),
      setTranslationMode: (translationMode) => set({ translationMode }),
      setAudioSource: (audioSource) => set({ audioSource }),
      setPreferredMicDeviceId: (preferredMicDeviceId) =>
        set({ preferredMicDeviceId }),
      setSonioxRegionPreference: (sonioxRegionPreference) =>
        set({ sonioxRegionPreference }),
      setDomain: (domain) => set({ domain }),
      setTopic: (topic) => set({ topic }),
      setTerms: (terms) => set({ terms }),
      setLlmProvider: (llmProvider) => set({ llmProvider }),
      setSummaryTriggerSentences: (summaryTriggerSentences) =>
        set({ summaryTriggerSentences }),
      setSummaryTriggerMinutes: (summaryTriggerMinutes) =>
        set({ summaryTriggerMinutes }),
      setSummaryLanguage: (summaryLanguage) => set({ summaryLanguage }),
      setSegmentSplitRatio: (segmentSplitRatio) => set({ segmentSplitRatio }),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setUserSettingsOpen: (userSettingsOpen) => set({ userSettingsOpen }),

      getSessionConfig: (sessionId) => {
        const s = get();
        const terms =
          sessionId &&
          s.pendingSessionId === sessionId &&
          Array.isArray(s.pendingSessionTerms)
            ? s.pendingSessionTerms
            : s.terms;

        return {
          model: 'stt-rt-v4' as const,
          sourceLang: s.sourceLang,
          targetLang: s.targetLang,
          languageHints: s.languageHints,
          languageHintsStrict: undefined,
          enableSpeakerDiarization: s.enableSpeakerDiarization,
          enableLanguageIdentification: s.enableLanguageIdentification,
          enableEndpointDetection: s.enableEndpointDetection,
          endpointDetectionMs: s.endpointDetectionMs,
          translationMode: s.translationMode,
          domain: s.domain,
          topic: s.topic,
          terms,
          sonioxRegionPreference: s.sonioxRegionPreference,
          clientReferenceId: sessionId,
        };
      },
    }),
    {
      name: 'lecture-live-settings',
      partialize: (state) => {
        const rest: Partial<SettingsStore> = { ...state };
        delete rest.pendingAutoStart;
        delete rest.pendingSystemStream;
        delete rest.pendingSessionId;
        delete rest.pendingSessionTerms;
        delete rest.userSettingsOpen;
        return rest;
      },
    }
  )
);
