'use client';

// 客户端 Provider 包装器 — 用于在服务端 layout 中包裹客户端上下文

import ThemeProvider from '@/components/ThemeProvider';
import I18nProvider from '@/components/I18nProvider';
import SiteDefaultsBootstrap from '@/components/SiteDefaultsBootstrap';
import OriginGuard from '@/components/OriginGuard';
import AuthSessionMonitor from '@/components/AuthSessionMonitor';
import ViewportAdapter from '@/components/ViewportAdapter';
import type { Locale } from '@/lib/i18n';
import type { TranslationMode, SonioxRegionPreference } from '@/types/transcript';

interface ClientProvidersProps {
  children: React.ReactNode;
  defaults: {
    locale: Locale;
    theme: 'light' | 'dark';
    sourceLang: string;
    targetLang: string;
    translationMode: TranslationMode;
    sonioxRegionPreference: SonioxRegionPreference;
  };
}

export default function ClientProviders({
  children,
  defaults,
}: ClientProvidersProps) {
  return (
    <I18nProvider defaultLocale={defaults.locale}>
      <ThemeProvider defaultTheme={defaults.theme}>
        <SiteDefaultsBootstrap defaults={defaults} />
        <AuthSessionMonitor />
        <ViewportAdapter />
        <OriginGuard>
          {children}
        </OriginGuard>
      </ThemeProvider>
    </I18nProvider>
  );
}
