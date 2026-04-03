'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { Loader2 } from 'lucide-react';
import SiteLogo from '@/components/SiteLogo';
import { useI18n } from '@/lib/i18n';
import DOMPurify from 'dompurify';

export default function LoginPage() {
  const router = useRouter();
  const { loginUser } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [siteName, setSiteName] = useState('LectureLive');
  const [subtitle, setSubtitle] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [footerCode, setFooterCode] = useState('');
  const [allowRegistration, setAllowRegistration] = useState(true);

  useEffect(() => {
    const loadSiteConfig = async () => {
      try {
        const res = await fetch('/api/site-config');
        if (!res.ok) return;
        const data = await res.json();
        setSiteName(
          typeof data.site_name === 'string' && data.site_name.trim()
            ? data.site_name.trim()
            : 'LectureLive'
        );
        setSubtitle(
          typeof data.site_description === 'string' ? data.site_description : ''
        );
        setAnnouncement(
          typeof data.site_announcement === 'string' ? data.site_announcement : ''
        );
        setFooterCode(
          typeof data.footer_code === 'string' ? data.footer_code : ''
        );
        setAllowRegistration(data.allow_registration !== false);
      } catch {
        // Ignore site branding fetch failures on login screen.
      }
    };

    void loadSiteConfig();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await loginUser(email, password);
      router.push('/home');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-cream-50 px-4">
      <div className="w-full max-w-sm flex-1 flex flex-col justify-center">
        <div className="text-center mb-8 animate-fade-in-up">
          <div className="mx-auto mb-3 animate-pop-in">
            <SiteLogo size="w-12 h-12" iconSize="w-6 h-6" />
          </div>
          <h1 className="font-serif text-2xl font-bold text-charcoal-800">
            {siteName || t('nav.appName')}
          </h1>
          <p className="text-sm text-charcoal-400 mt-1">
            {subtitle || t('auth.signInToAccount')}
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-xl shadow-sm border border-cream-200 p-6 space-y-4 animate-fade-in-up stagger-2"
        >
          {announcement && (
            <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
              {announcement}
            </div>
          )}
          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600 animate-shake">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-charcoal-600 mb-1">
              {t('auth.email')}
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm
                         focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-charcoal-600 mb-1">
              {t('auth.password')}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm
                         focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-rust-500 text-white rounded-lg text-sm font-medium
                       hover:bg-rust-600 disabled:opacity-50 transition-all duration-200
                       flex items-center justify-center gap-2 btn-bounce"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('auth.signIn')}
          </button>

          {allowRegistration && (
            <p className="text-center text-xs text-charcoal-400">
              {t('auth.noAccount')}{' '}
              <Link href="/register" className="text-rust-500 hover:underline">
                {t('auth.register')}
              </Link>
            </p>
          )}
        </form>
      </div>
      {footerCode && (
        <div
          className="w-full max-w-sm py-4 text-center text-xs text-charcoal-400"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(footerCode) }}
        />
      )}
    </div>
  );
}
