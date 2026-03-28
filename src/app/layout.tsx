import type { Metadata, Viewport } from 'next';
import './globals.css';
import ClientProviders from '@/components/ClientProviders';
import { getSiteSettings } from '@/lib/siteSettings';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // maximumScale 由 ViewportAdapter 动态管理：
  // 普通手机: maximum-scale=1（防止 iOS 输入框自动缩放）
  // 折叠屏/桌面模式: 不限制（允许缩放适配）
  viewportFit: 'cover',
  themeColor: '#C75B3A',
};

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSiteSettings().catch(() => null);
  const title =
    settings?.site_name?.trim() ||
    'LectureLive — Real-time Lecture Transcription';
  const description =
    settings?.site_description?.trim() ||
    'Real-time speech-to-text transcription, translation, and AI-powered note-taking for academic lectures.';
  const favicon = settings?.favicon_path?.trim();
  const iconMedium = settings?.icon_medium_path?.trim();
  const iconLarge = settings?.icon_large_path?.trim();

  // favicon：优先使用管理员上传的，否则回退到 public/ 默认图标
  const icons: Record<string, unknown> = {
    icon: favicon || '/icon.svg',
  };
  const apple: { url: string; sizes: string }[] = [];
  if (iconMedium) {
    apple.push({ url: iconMedium, sizes: '120x120' });
  }
  if (iconLarge) {
    apple.push({ url: iconLarge, sizes: '180x180' });
  } else {
    // 回退到 public/ 默认 PWA 图标
    apple.push({ url: '/icon-192.png', sizes: '192x192' });
  }
  icons.apple = apple;

  return {
    title,
    description,
    manifest: '/manifest.json',
    appleWebApp: {
      capable: true,
      statusBarStyle: 'black-translucent',
      title: settings?.site_name?.trim() || 'LectureLive',
    },
    icons,
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const settings = await getSiteSettings().catch(() => null);
  const locale = settings?.language === 'zh' ? 'zh' : 'en';
  const theme = settings?.theme === 'dark' ? 'dark' : 'light';

  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="min-h-screen">
        <ClientProviders
          defaults={{
            locale,
            theme,
            sourceLang: settings?.default_source_lang ?? 'en',
            targetLang: settings?.default_target_lang ?? 'zh',
            translationMode: settings?.translation_mode ?? 'soniox',
            sonioxRegionPreference: settings?.default_region ?? 'auto',
          }}
        >
          {children}
        </ClientProviders>
      </body>
    </html>
  );
}
