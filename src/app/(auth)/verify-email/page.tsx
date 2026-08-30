'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import SiteLogo from '@/components/SiteLogo';
import ThemeSwitcher from '@/components/ThemeSwitcher';
import { useI18n } from '@/lib/i18n';
import {
  getAuthBoundarySnapshot,
  isPersistedAuthBoundaryCurrent,
  useAuthStore,
} from '@/stores/authStore';
import {
  consumeAuthMutationJson,
  parseAuthMutationSession,
  revokeUncommittedAuthSession,
  runAuthCookieMutation,
} from '@/lib/clientAuthCookieMutation';

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
    const expected = getAuthBoundarySnapshot();

    (async () => {
      try {
        const verified = await runAuthCookieMutation(async () => {
          if (!isPersistedAuthBoundaryCurrent(expected)) {
            throw new DOMException('Stale auth request', 'AbortError');
          }
          const res = await fetch('/api/auth/verify-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
          });
          const { data, sessionBinding } =
            await consumeAuthMutationJson<{
              sessionBinding?: unknown;
              verified?: boolean;
              user?: unknown;
              token?: unknown;
            }>(res, {
              expected,
            });
          const session = parseAuthMutationSession(data);
          if (
            !res.ok ||
            !data?.verified ||
            !sessionBinding ||
            !session
          ) {
            if (res.ok) {
              await revokeUncommittedAuthSession(sessionBinding, expected);
            }
            setStatus('error');
            setErrorMsg(
              res.status === 429
                ? t('auth.rateLimited')
                : t('auth.verifyFailed')
            );
            return false;
          }
          if (!isPersistedAuthBoundaryCurrent(expected)) {
            await revokeUncommittedAuthSession(sessionBinding, expected);
            return false;
          }
          const committed = await setAuth(session.user, session.token, {
            expected,
            sessionBinding,
          });
          if (!committed) {
            await revokeUncommittedAuthSession(sessionBinding, expected);
          }
          return committed;
        });
        if (!verified) return;
        setStatus('success');
        // replace 而非 push：验证令牌是一次性的，把本页留在历史里意味着用户按一下后退
        // 就会重放已消费的链接，然后对着一个刚验证成功的账号弹「链接无效或已过期」。
        setTimeout(() => router.replace('/home'), 1500);
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
