import type { MetadataRoute } from 'next';
import { getSiteSettings } from '@/lib/siteSettings';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const settings = await getSiteSettings().catch(() => null);
  const name = settings?.site_name?.trim() || 'LectureLive';
  const iconLarge = settings?.icon_large_path?.trim();

  return {
    name,
    short_name: name,
    description:
      settings?.site_description?.trim() ||
      'Real-time lecture transcription, translation, and intelligent notes.',
    start_url: '/home',
    display: 'standalone',
    background_color: '#FAF8F5',
    theme_color: '#C75B3A',
    icons: [
      {
        src: iconLarge || '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: iconLarge || '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  };
}
