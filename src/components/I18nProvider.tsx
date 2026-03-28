'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { I18nContext, getTranslation, type Locale } from '@/lib/i18n';

const STORAGE_KEY = 'lecture-live-locale';

function getStoredLocale(defaultLocale: Locale): Locale {
  if (typeof window === 'undefined') return 'en';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {}
  return defaultLocale;
}

export default function I18nProvider({
  children,
  defaultLocale = 'en',
}: {
  children: React.ReactNode;
  defaultLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);

  useEffect(() => {
    const storedLocale = getStoredLocale(defaultLocale);
    setLocaleState(storedLocale);
    document.documentElement.lang = storedLocale;
  }, [defaultLocale]);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    try { localStorage.setItem(STORAGE_KEY, newLocale); } catch {}
    // 更新 html lang 属性
    document.documentElement.lang = newLocale;
  }, []);

  const t = useMemo(() => getTranslation(locale), [locale]);

  const value = useMemo(() => ({ locale, t, setLocale }), [locale, t, setLocale]);

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}
