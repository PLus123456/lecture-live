'use client';

// 客户端 Provider 包装器 — 用于在服务端 layout 中包裹客户端上下文

import ThemeProvider from '@/components/ThemeProvider';
import I18nProvider from '@/components/I18nProvider';
import SiteDefaultsBootstrap from '@/components/SiteDefaultsBootstrap';
import OriginGuard from '@/components/OriginGuard';
import AuthSessionMonitor from '@/components/AuthSessionMonitor';
import ViewportAdapter from '@/components/ViewportAdapter';
import Toaster from '@/components/Toaster';
import GlobalUploadDropzone from '@/components/global/GlobalUploadDropzone';
import UploadJobsTracker from '@/components/global/UploadJobsTracker';
import type { Locale } from '@/lib/i18n';
import type { TranslationMode, SonioxRegionPreference } from '@/types/transcript';
import { useAuthStore } from '@/stores/authStore';
import { handleExternalAuthStorageBoundary } from '@/lib/clientAuthStorageBoundary';
import { Fragment, useEffect } from 'react';

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
  const accountKey = useAuthStore((state) => state.user?.id ?? 'anonymous');

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'lecture-live-auth') return;
      void handleExternalAuthStorageBoundary(event.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return (
    <I18nProvider defaultLocale={defaults.locale}>
      <ThemeProvider defaultTheme={defaults.theme}>
        <SiteDefaultsBootstrap defaults={defaults} />
        <AuthSessionMonitor />
        <ViewportAdapter />
        <Fragment key={`account:${accountKey}`}>
          <OriginGuard>
            {children}
          </OriginGuard>
          <GlobalUploadDropzone />
          <UploadJobsTracker />
          <Toaster />
        </Fragment>
      </ThemeProvider>
    </I18nProvider>
  );
}
