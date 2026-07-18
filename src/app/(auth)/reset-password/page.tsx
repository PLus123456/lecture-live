'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, CheckCircle2 } from 'lucide-react';
import SiteLogo from '@/components/SiteLogo';
import ThemeSwitcher from '@/components/ThemeSwitcher';
import { useI18n } from '@/lib/i18n';

export default function ResetPasswordPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [minLength, setMinLength] = useState(8);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  // 从 URL 读取 token（客户端读取，避免 useSearchParams 的 Suspense 约束）。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get('token'));
  }, []);

  useEffect(() => {
    fetch('/api/site-config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (typeof data?.password_min_length === 'number' && data.password_min_length >= 8) {
          setMinLength(data.password_min_length);
        }
      })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError(t('auth.passwordMismatch'));
      return;
    }
    if (!token) {
      setError(t('auth.resetLinkInvalid'));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? t('common.networkError'));
        return;
      }
      setDone(true);
      setTimeout(() => router.push('/login'), 2500);
    } catch {
      setError(t('common.networkError'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-cream-50 px-4">
      <ThemeSwitcher variant="button" className="fixed right-4 top-4 z-10" />
      <div className="w-full max-w-sm">
        <div className="text-center mb-8 animate-fade-in-up">
          <div className="mx-auto mb-3 animate-pop-in">
            <SiteLogo size="w-12 h-12" iconSize="w-6 h-6" />
          </div>
          <h1 className="font-serif text-2xl font-bold text-charcoal-800">
            {t('auth.resetPasswordTitle')}
          </h1>
        </div>

        {done ? (
          <div className="bg-white rounded-xl shadow-sm border border-cream-200 p-6 space-y-4 animate-fade-in-up text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-green-50 flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-green-600" />
            </div>
            <p className="text-sm text-charcoal-600">{t('auth.resetPasswordDone')}</p>
            <Link href="/login" className="inline-block text-sm text-rust-500 hover:underline">
              {t('auth.backToSignIn')}
            </Link>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="bg-white rounded-xl shadow-sm border border-cream-200 p-6 space-y-4 animate-fade-in-up stagger-2"
          >
            {error && (
              <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600 animate-shake">
                {error}
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-charcoal-600 mb-1">
                {t('auth.newPassword')}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={minLength}
                className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm
                           focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-charcoal-600 mb-1">
                {t('auth.confirmPassword')}
              </label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={minLength}
                className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm
                           focus:outline-none focus:ring-2 focus:ring-rust-400 focus:border-transparent"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !token}
              className="w-full py-2.5 bg-rust-500 text-white rounded-lg text-sm font-medium
                         hover:bg-rust-600 disabled:opacity-50 transition-all duration-200
                         flex items-center justify-center gap-2 btn-bounce"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('auth.resetPasswordSubmit')}
            </button>
            <p className="text-center text-xs text-charcoal-400">
              <Link href="/login" className="text-rust-500 hover:underline">
                {t('auth.backToSignIn')}
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
