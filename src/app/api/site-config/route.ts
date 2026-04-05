import { NextResponse } from 'next/server';
import { getSiteSettings, toPublicSiteConfig } from '@/lib/siteSettings';
import { jsonWithCache } from '@/lib/httpCache';

export async function GET(req: Request) {
  try {
    const settings = await getSiteSettings();
    return jsonWithCache(req, toPublicSiteConfig(settings), {
      cacheControl: 'public, no-cache, must-revalidate',
    });
  } catch (error) {
    console.error('Failed to load public site config:', error);
    return jsonWithCache(
      req,
      {
        site_name: 'LectureLive',
        site_description: '',
        site_announcement: '',
        footer_code: '',
        terms_url: '/terms',
        privacy_url: '/privacy',
        logo_path: '',
        favicon_path: '',
        site_url: '',
        site_url_backups: [],
        allow_registration: true,
        password_min_length: 8,
        theme: 'cream',
        language: 'en',
        default_region: 'auto',
        default_source_lang: 'en',
        default_target_lang: 'zh',
        translation_mode: 'soniox',
      },
      {
        cacheControl: 'public, no-cache, must-revalidate',
      }
    );
  }
}
