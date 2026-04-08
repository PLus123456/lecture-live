'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { I18nContext, getTranslation, detectBrowserLocale, SUPPORTED_LOCALES, type Locale } from '@/lib/i18n';

const STORAGE_KEY = 'lecture-live-locale';

function isValidLocale(v: string | null): v is Locale {
  return !!v && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

function getStoredLocale(defaultLocale: Locale): Locale {
  if (typeof window === 'undefined') return defaultLocale;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isValidLocale(stored)) return stored;
  } catch {}
  // 首次访问：根据浏览器语言自动检测，并写入 localStorage 避免重复检测
  const detected = detectBrowserLocale(defaultLocale);
  try { localStorage.setItem(STORAGE_KEY, detected); } catch {}
  return detected;
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
