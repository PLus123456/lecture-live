'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import SiteLogo from '@/components/SiteLogo';
import ThemeSwitcher from '@/components/ThemeSwitcher';
import { useI18n } from '@/lib/i18n';
import { useAuthStore } from '@/stores/authStore';

type Status = 'verifying' | 'success' | 'error';

export default function VerifyEmailPage() {
  const router = useRouter();
  const { t } = useI18n();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [status, setStatus] = useState<Status>('verifying');
  const [errorMsg, setErrorMsg] = useState('');
  const startedRef = useRef(false); // 防 StrictMode/重渲染重复提交（token 单次，二次必失败）

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      setStatus('error');
      setErrorMsg(t('auth.verifyMissingToken'));
      return;
    }

    (async () => {
      try {
        const res = await fetch('/api/auth/verify-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await res.json().catch(() => null);
        // 文案走 i18n 键，不采用服务端 error（服务端永远是硬编码中文，英文键因此成了死代码）。
        if (!res.ok || !data?.verified) {
          setStatus('error');
          setErrorMsg(res.status === 429 ? t('auth.rateLimited') : t('auth.verifyFailed'));
          return;
        }
        // 验证成功：后端已下发会话 cookie，同步客户端 store 后进入应用。
        setAuth(data.user, data.token);
        setStatus('success');
        setTimeout(() => router.push('/home'), 1500);
      } catch {
        setStatus('error');
        setErrorMsg(t('common.networkError'));
      }
    })();
  }, [router, setAuth, t]);

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-cream-50 px-4">
      <ThemeSwitcher variant="button" className="fixed right-4 top-4 z-10" />
      <div className="w-full max-w-sm">
        <div className="text-center mb-8 animate-fade-in-up">
          <div className="mx-auto mb-3 animate-pop-in">
            <SiteLogo size="w-12 h-12" iconSize="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-cream-200 p-6 space-y-4 animate-fade-in-up text-center">
          {status === 'verifying' && (
            <>
              <Loader2 className="w-8 h-8 text-rust-500 animate-spin mx-auto" />
              <p className="text-sm text-charcoal-600">{t('auth.verifying')}</p>
            </>
          )}
          {status === 'success' && (
            <>
              <div className="mx-auto w-12 h-12 rounded-full bg-green-50 flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6 text-green-600" />
              </div>
              <p className="text-sm text-charcoal-600">{t('auth.verifySuccess')}</p>
            </>
          )}
          {status === 'error' && (
            <>
              <div className="mx-auto w-12 h-12 rounded-full bg-red-50 flex items-center justify-center">
                <XCircle className="w-6 h-6 text-red-500" />
              </div>
              <p className="text-sm text-charcoal-600">{errorMsg}</p>
              <Link href="/login" className="inline-block text-sm text-rust-500 hover:underline">
                {t('auth.backToSignIn')}
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
