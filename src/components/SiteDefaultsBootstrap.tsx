'use client';

import { useEffect } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Locale } from '@/lib/i18n';
import type { TranslationMode, SonioxRegionPreference } from '@/types/transcript';

interface SiteDefaultsBootstrapProps {
  defaults: {
    locale: Locale;
    sourceLang: string;
    targetLang: string;
    translationMode: TranslationMode;
    sonioxRegionPreference: SonioxRegionPreference;
  };
}

export default function SiteDefaultsBootstrap({
  defaults,
}: SiteDefaultsBootstrapProps) {
  const setSourceLang = useSettingsStore((s) => s.setSourceLang);
  const setTargetLang = useSettingsStore((s) => s.setTargetLang);
  const setTranslationMode = useSettingsStore((s) => s.setTranslationMode);
  const setSonioxRegionPreference = useSettingsStore(
    (s) => s.setSonioxRegionPreference
  );

  useEffect(() => {
    try {
      if (localStorage.getItem('lecture-live-settings')) {
        return;
      }
    } catch {
      return;
    }

    setSourceLang(defaults.sourceLang);
    setTargetLang(defaults.targetLang);
    setTranslationMode(defaults.translationMode);
    setSonioxRegionPreference(defaults.sonioxRegionPreference);
  }, [
    defaults.locale,
    defaults.sonioxRegionPreference,
    defaults.sourceLang,
    defaults.targetLang,
    defaults.translationMode,
    setSonioxRegionPreference,
    setSourceLang,
    setTargetLang,
    setTranslationMode,
  ]);

  return null;
}
