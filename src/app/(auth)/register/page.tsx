'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { Loader2, MailCheck } from 'lucide-react';
import SiteLogo from '@/components/SiteLogo';
import { useI18n } from '@/lib/i18n';
import DOMPurify from 'dompurify';
import ThemeSwitcher from '@/components/ThemeSwitcher';

export default function RegisterPage() {
  const router = useRouter();
  const { registerUser } = useAuth();
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [siteName, setSiteName] = useState('LectureLive');
  const [subtitle, setSubtitle] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [footerCode, setFooterCode] = useState('');
  const [allowRegistration, setAllowRegistration] = useState(true);
  const [passwordMinLength, setPasswordMinLength] = useState(8);
  // 邮箱验证硬门禁：注册成功但需验证时，进入「去邮箱查收」态（不跳转 /home）。
  const [verificationSentTo, setVerificationSentTo] = useState<string | null>(null);
  const [resendMsg, setResendMsg] = useState('');
  const [resending, setResending] = useState(false);

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
        setPasswordMinLength(
          typeof data.password_min_length === 'number' && data.password_min_length >= 8
            ? data.password_min_length
            : 8
        );
      } catch {
        // Ignore site branding fetch failures on register screen.
      }
    };

    void loadSiteConfig();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allowRegistration) {
      setError(t('auth.registrationDisabled'));
      return;
    }
    setError('');
    setLoading(true);
    try {
      const result = await registerUser(email, password, displayName);
      if (result && 'verificationRequired' in result && result.verificationRequired) {
        setVerificationSentTo(email);
        return;
      }
      router.push('/home');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!verificationSentTo) return;
    setResending(true);
    setResendMsg('');
    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: verificationSentTo }),
      });
      const data = await res.json().catch(() => null);
      setResendMsg(data?.message ?? t('auth.verificationResent'));
    } catch {
      setResendMsg(t('common.networkError'));
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-cream-50 px-4">
      <ThemeSwitcher variant="button" className="fixed right-4 top-4 z-10" />
      <div className="w-full max-w-sm flex-1 flex flex-col justify-center">
        <div className="text-center mb-8 animate-fade-in-up">
          <div className="mx-auto mb-3 animate-pop-in">
            <SiteLogo size="w-12 h-12" iconSize="w-6 h-6" />
          </div>
          <h1 className="font-serif text-2xl font-bold text-charcoal-800">
            {siteName || t('nav.appName')}
          </h1>
          <p className="text-sm text-charcoal-400 mt-1">
            {subtitle || t('auth.createYourAccount')}
          </p>
        </div>

        {verificationSentTo ? (
          <div className="bg-white rounded-xl shadow-sm border border-cream-200 p-6 space-y-4 animate-fade-in-up stagger-2 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-green-50 flex items-center justify-center">
              <MailCheck className="w-6 h-6 text-green-600" />
            </div>
            <h2 className="font-serif text-lg font-bold text-charcoal-800">
              {t('auth.checkEmailTitle')}
            </h2>
            <p className="text-sm text-charcoal-500">
              {t('auth.checkEmailDesc', { email: verificationSentTo })}
            </p>
            {resendMsg && (
              <div className="px-3 py-2 rounded-lg bg-cream-50 border border-cream-200 text-xs text-charcoal-600">
                {resendMsg}
              </div>
            )}
            <button
              type="button"
              onClick={handleResend}
              disabled={resending}
              className="w-full py-2.5 border border-cream-300 text-charcoal-700 rounded-lg text-sm font-medium
                         hover:bg-cream-50 disabled:opacity-50 transition-all duration-200
                         flex items-center justify-center gap-2"
            >
              {resending && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('auth.resendVerification')}
            </button>
            <p className="text-center text-xs text-charcoal-400">
              <Link href="/login" className="text-rust-500 hover:underline">
                {t('auth.backToSignIn')}
              </Link>
            </p>
          </div>
        ) : (
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-xl shadow-sm border border-cream-200 p-6 space-y-4 animate-fade-in-up stagger-2"
        >
          {announcement && (
            <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
              {announcement}
            </div>
          )}
          {!allowRegistration && (
            <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
              <div className="font-medium">{t('auth.registrationDisabled')}</div>
              <div className="mt-1">{t('auth.registrationDisabledDesc')}</div>
            </div>
          )}
          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600 animate-shake">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-charcoal-600 mb-1">
              {t('auth.displayName')}
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm
                         focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
            />
          </div>

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
              {t('auth.passwordMinCharsDynamic', { n: passwordMinLength })}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={passwordMinLength}
              disabled={!allowRegistration}
              className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm
                         focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !allowRegistration}
            className="w-full py-2.5 bg-rust-500 text-white rounded-lg text-sm font-medium
                       hover:bg-rust-600 disabled:opacity-50 transition-all duration-200
                       flex items-center justify-center gap-2 btn-bounce"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('auth.createAccount')}
          </button>

          <p className="text-center text-xs text-charcoal-400">
            {t('auth.hasAccount')}{' '}
            <Link href="/login" className="text-rust-500 hover:underline">
              {t('auth.signIn')}
            </Link>
          </p>
        </form>
        )}
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
