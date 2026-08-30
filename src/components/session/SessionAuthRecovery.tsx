'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RestoreSessionResult } from '@/hooks/useAuth';
import { useI18n } from '@/lib/i18n';

interface SessionAuthRecoveryProps {
  sessionChecked: boolean;
  restoreSession: () => Promise<RestoreSessionResult>;
  pendingMessage: string;
}

/**
 * Authentication fallback shared by the standalone session pages.
 *
 * A pre-existing `sessionChecked=true` with no rendered authenticated page is
 * an explicit anonymous boundary (logout/401 cleanup), so it must never start
 * a refresh. A recovery already in flight may briefly publish that shape while
 * setAuth clears the previous account; that transition is resolved by the
 * boundary-checked recovery result instead.
 */
export default function SessionAuthRecovery({
  sessionChecked,
  restoreSession,
  pendingMessage,
}: SessionAuthRecoveryProps) {
  const router = useRouter();
  const { t } = useI18n();
  const restoreAttemptedRef = useRef(false);
  const restoreInFlightRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const sessionCheckedRef = useRef(sessionChecked);
  const [unavailable, setUnavailable] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);
  sessionCheckedRef.current = sessionChecked;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (sessionChecked && !restoreInFlightRef.current) {
      // Invalidate any superseded callback before routing away. A confirmed
      // anonymous boundary must not be undone by old recovery work.
      requestGenerationRef.current += 1;
      router.replace('/login');
      return;
    }

    // setAuth deliberately publishes a short anonymous transition while it
    // clears the previous account's client state. During a recovery already
    // in flight, wait for its boundary-checked result instead of mistaking
    // that transition for a completed logout.
    if (restoreInFlightRef.current || restoreAttemptedRef.current) return;
    restoreAttemptedRef.current = true;
    restoreInFlightRef.current = true;
    const requestGeneration = ++requestGenerationRef.current;

    void restoreSession().then((result) => {
      if (
        !mountedRef.current ||
        requestGenerationRef.current !== requestGeneration
      ) {
        return;
      }

      restoreInFlightRef.current = false;
      if (result === 'invalid') {
        router.replace('/login');
      } else if (result === 'unavailable') {
        if (sessionCheckedRef.current) {
          router.replace('/login');
          return;
        }
        setUnavailable(true);
      } else if (result === 'stale' && sessionCheckedRef.current) {
        router.replace('/login');
      }
    });
  }, [restoreSession, retryGeneration, router, sessionChecked]);

  if (unavailable) {
    return (
      <div className="min-h-[100dvh] bg-cream-50 flex items-center justify-center px-6">
        <div className="max-w-md rounded-2xl border border-amber-200 bg-white p-6 text-center shadow-sm">
          <p className="font-semibold text-charcoal-800">
            {t('auth.sessionServiceUnavailable')}
          </p>
          <p className="mt-2 text-sm text-charcoal-500">
            {t('auth.sessionServiceUnavailableDescription')}
          </p>
          <button
            type="button"
            className="mt-4 rounded-xl bg-rust-500 px-4 py-2 text-sm font-semibold text-white"
            onClick={() => {
              requestGenerationRef.current += 1;
              restoreAttemptedRef.current = false;
              restoreInFlightRef.current = false;
              setUnavailable(false);
              setRetryGeneration((value) => value + 1);
            }}
          >
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-cream-50">
      <div className="text-charcoal-400 text-sm">{pendingMessage}</div>
    </div>
  );
}
