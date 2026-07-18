'use client';

import { useState } from 'react';
import { Loader2, Send, Users } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

/**
 * 管理员群发（产品更新 / 促销）。这是 sendGenericNotificationEmail 的唯一入口 ——
 * 在它接上之前，用户侧的「产品更新 / 优惠促销」开关与站点营销总开关全是摆设。
 *
 * 群发不可撤回，所以流程强制三步：先看人数 → 再发测试信给自己 → 最后二次确认才真发。
 */

type Category = 'product_updates' | 'promotions';
type Audience = 'all' | 'FREE' | 'PRO' | 'ADMIN';

interface PreviewState {
  recipientCount: number;
  truncated: boolean;
  marketingEnabled: boolean;
}

export default function EmailBroadcastSection() {
  const { t } = useI18n();
  const [category, setCategory] = useState<Category>('product_updates');
  const [audience, setAudience] = useState<Audience>('all');
  const [subject, setSubject] = useState('');
  const [heading, setHeading] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [ctaUrl, setCtaUrl] = useState('');
  const [ctaLabel, setCtaLabel] = useState('');

  const [busy, setBusy] = useState<null | 'preview' | 'test' | 'send'>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const contentReady = Boolean(subject.trim() && heading.trim() && bodyText.trim());

  const call = async (mode: 'preview' | 'test' | 'send') => {
    setBusy(mode);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/email/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          category,
          audience,
          subject,
          heading,
          bodyText,
          ...(ctaUrl || ctaLabel ? { cta: { url: ctaUrl, label: ctaLabel } } : {}),
        }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setMessage({ ok: false, text: data?.error || t('common.saveFailed') });
        return;
      }

      if (mode === 'preview') {
        setPreview({
          recipientCount: data.recipientCount ?? 0,
          truncated: Boolean(data.truncated),
          marketingEnabled: Boolean(data.marketingEnabled),
        });
      } else if (mode === 'test') {
        setMessage({
          ok: true,
          text: t('adminSettings.broadcastTestSent', { email: data.sentTo ?? '' }),
        });
      } else {
        setConfirming(false);
        setPreview(null);
        setMessage({
          ok: true,
          text: t('adminSettings.broadcastDispatched', { n: data.dispatched ?? 0 }),
        });
      }
    } catch {
      setMessage({ ok: false, text: t('common.networkError') });
    } finally {
      setBusy(null);
    }
  };

  const inputClass =
    'w-full px-3 py-1.5 text-xs rounded-lg border border-cream-300 dark:border-charcoal-600 ' +
    'dark:bg-charcoal-800 dark:text-cream-100 focus:outline-none focus:ring-2 focus:ring-rust-400';

  return (
    <div className="py-4 border-t border-cream-100 dark:border-charcoal-700 space-y-3">
      <div className="text-sm font-medium text-charcoal-700 dark:text-cream-200">
        {t('adminSettings.broadcastTitle')}
      </div>
      <p className="text-xs text-charcoal-400 dark:text-charcoal-500">
        {t('adminSettings.broadcastDesc')}
      </p>

      <div className="flex flex-wrap gap-2">
        <select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value as Category);
            setPreview(null);
          }}
          className={inputClass + ' flex-1 min-w-[160px]'}
        >
          <option value="product_updates">{t('emailPrefs.category.product_updates')}</option>
          <option value="promotions">{t('emailPrefs.category.promotions')}</option>
        </select>
        <select
          value={audience}
          onChange={(e) => {
            setAudience(e.target.value as Audience);
            setPreview(null);
          }}
          className={inputClass + ' flex-1 min-w-[160px]'}
        >
          <option value="all">{t('adminSettings.broadcastAudienceAll')}</option>
          <option value="FREE">FREE</option>
          <option value="PRO">PRO</option>
          <option value="ADMIN">ADMIN</option>
        </select>
      </div>

      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder={t('adminSettings.broadcastSubject')}
        className={inputClass}
      />
      <input
        type="text"
        value={heading}
        onChange={(e) => setHeading(e.target.value)}
        placeholder={t('adminSettings.broadcastHeading')}
        className={inputClass}
      />
      <textarea
        value={bodyText}
        onChange={(e) => setBodyText(e.target.value)}
        placeholder={t('adminSettings.broadcastBody')}
        rows={5}
        className={inputClass + ' resize-y'}
      />
      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          value={ctaLabel}
          onChange={(e) => setCtaLabel(e.target.value)}
          placeholder={t('adminSettings.broadcastCtaLabel')}
          className={inputClass + ' flex-1 min-w-[140px]'}
        />
        <input
          type="url"
          value={ctaUrl}
          onChange={(e) => setCtaUrl(e.target.value)}
          placeholder="https://example.com/changelog"
          className={inputClass + ' flex-[2] min-w-[180px]'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void call('preview')}
          disabled={busy !== null || !contentReady}
          className="px-3 py-1.5 text-xs font-medium text-charcoal-600 border border-cream-200 rounded-lg
                     hover:bg-cream-50 dark:text-cream-200 dark:border-charcoal-600 dark:hover:bg-charcoal-700
                     transition-colors disabled:opacity-50 flex items-center gap-1.5"
        >
          {busy === 'preview' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Users className="w-3.5 h-3.5" />
          )}
          {t('adminSettings.broadcastCountRecipients')}
        </button>
        <button
          type="button"
          onClick={() => void call('test')}
          disabled={busy !== null || !contentReady}
          className="px-3 py-1.5 text-xs font-medium text-charcoal-600 border border-cream-200 rounded-lg
                     hover:bg-cream-50 dark:text-cream-200 dark:border-charcoal-600 dark:hover:bg-charcoal-700
                     transition-colors disabled:opacity-50"
        >
          {busy === 'test' ? t('common.loading') : t('adminSettings.broadcastSendTest')}
        </button>
      </div>

      {preview && (
        <div className="px-3 py-2 rounded-lg bg-cream-50 dark:bg-charcoal-700 text-xs space-y-1">
          <div className="text-charcoal-600 dark:text-cream-200">
            {t('adminSettings.broadcastRecipientCount', { n: preview.recipientCount })}
          </div>
          {!preview.marketingEnabled && (
            <div className="text-amber-600 dark:text-amber-400">
              {t('adminSettings.broadcastMarketingOff')}
            </div>
          )}
          {preview.truncated && (
            <div className="text-amber-600 dark:text-amber-400">
              {t('adminSettings.broadcastTruncated')}
            </div>
          )}
          {preview.recipientCount > 0 &&
            (confirming ? (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-rust-500">
                  {t('adminSettings.broadcastConfirm', { n: preview.recipientCount })}
                </span>
                <button
                  type="button"
                  onClick={() => void call('send')}
                  disabled={busy !== null}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-rust-500 rounded-lg
                             hover:bg-rust-600 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                  {busy === 'send' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5" />
                  )}
                  {t('adminSettings.broadcastConfirmSend')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="px-3 py-1.5 text-xs text-charcoal-500 hover:underline"
                >
                  {t('common.cancel')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="mt-1 px-3 py-1.5 text-xs font-medium text-white bg-rust-500 rounded-lg
                           hover:bg-rust-600 transition-colors flex items-center gap-1.5"
              >
                <Send className="w-3.5 h-3.5" />
                {t('adminSettings.broadcastSend')}
              </button>
            ))}
        </div>
      )}

      {message && (
        <div
          className={`text-xs ${
            message.ok ? 'text-green-600 dark:text-green-400' : 'text-rust-500'
          }`}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
