'use client';

// v2.1 §C.3: Overlay shown while session is finalizing
// (waiting for last tokens, merging audio, uploading, extracting keywords)

import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export interface FinalizingStep {
  label: string;
  status: 'pending' | 'active' | 'done' | 'error';
}

interface SessionFinalizingOverlayProps {
  steps: FinalizingStep[];
  visible: boolean;
}

export function SessionFinalizingOverlay({ steps, visible }: SessionFinalizingOverlayProps) {
  const { t } = useI18n();
  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-charcoal-900/40 backdrop-blur-sm animate-backdrop-enter" />
      <div className="relative bg-white rounded-2xl shadow-2xl border border-cream-200 p-8 w-[380px] animate-modal-enter">
        <div className="text-center mb-6">
          <Loader2 className="w-8 h-8 text-rust-500 animate-spin mx-auto mb-3" />
          <h2 className="font-serif font-bold text-charcoal-800 text-lg">{t('session.finalizing.title')}</h2>
          <p className="text-xs text-charcoal-400 mt-1">{t('session.finalizing.description')}</p>
        </div>

        <div className="space-y-3">
          {steps.map((step, i) => (
            <div key={i} className="flex items-center gap-3">
              {step.status === 'done' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
              ) : step.status === 'error' ? (
                <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
              ) : step.status === 'active' ? (
                <Loader2 className="w-4 h-4 text-rust-500 animate-spin flex-shrink-0" />
              ) : (
                <div className="w-4 h-4 rounded-full border-2 border-cream-300 flex-shrink-0" />
              )}
              <span
                className={`text-sm ${
                  step.status === 'done'
                    ? 'text-charcoal-400 line-through'
                    : step.status === 'error'
                      ? 'text-red-600 font-medium'
                    : step.status === 'active'
                      ? 'text-charcoal-800 font-medium'
                      : 'text-charcoal-400'
                }`}
              >
                {step.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
