'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2, MailCheck } from 'lucide-react';
import SiteLogo from '@/components/SiteLogo';
import ThemeSwitcher from '@/components/ThemeSwitcher';
import { useI18n } from '@/lib/i18n';

export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => null);
      // 防枚举：后端恒返回通用成功文案，前端一律进入「已发送」态。
      setMessage(data?.message ?? t('auth.forgotPasswordSent'));
      setSent(true);
    } catch {
      setMessage(t('common.networkError'));
      setSent(true);
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
            {t('auth.forgotPasswordTitle')}
          </h1>
          <p className="text-sm text-charcoal-400 mt-1">
            {t('auth.forgotPasswordSubtitle')}
          </p>
        </div>

        {sent ? (
          <div className="bg-white rounded-xl shadow-sm border border-cream-200 p-6 space-y-4 animate-fade-in-up text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-green-50 flex items-center justify-center">
              <MailCheck className="w-6 h-6 text-green-600" />
            </div>
            <p className="text-sm text-charcoal-600">{message}</p>
            <Link href="/login" className="inline-block text-sm text-rust-500 hover:underline">
              {t('auth.backToSignIn')}
            </Link>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="bg-white rounded-xl shadow-sm border border-cream-200 p-6 space-y-4 animate-fade-in-up stagger-2"
          >
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
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-rust-500 text-white rounded-lg text-sm font-medium
                         hover:bg-rust-600 disabled:opacity-50 transition-all duration-200
                         flex items-center justify-center gap-2 btn-bounce"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('auth.sendResetLink')}
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
