'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Share2, Copy, CheckCheck, X, Link2, Trash2, Loader2 } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';

interface PlaybackSharePopoverProps {
  sessionId: string;
  /** 仅图标模式（移动端） */
  iconOnly?: boolean;
}

export default function PlaybackSharePopover({ sessionId, iconOnly }: PlaybackSharePopoverProps) {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const [open, setOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [initialChecked, setInitialChecked] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  // 首次打开时查询是否已有有效的非 live 分享链接
  const checkExisting = useCallback(async () => {
    if (!token || initialChecked) return;
    try {
      const res = await fetch('/api/share/create', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const links = await res.json();
      const existing = (links as Array<{
        session: { id: string };
        isLive: boolean;
        expiresAt: string | null;
        token: string;
      }>).find(
        (l) =>
          l.session.id === sessionId &&
          !l.isLive &&
          (!l.expiresAt || new Date(l.expiresAt) > new Date()),
      );
      if (existing) {
        setShareUrl(
          `${window.location.origin}/session/${sessionId}/playback?token=${existing.token}`,
        );
      }
    } catch {
      // silent
    } finally {
      setInitialChecked(true);
    }
  }, [token, sessionId, initialChecked]);

  useEffect(() => {
    if (open && !initialChecked) {
      checkExisting();
    }
  }, [open, initialChecked, checkExisting]);

  const handleCreate = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch('/api/share/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ sessionId, isLive: false }),
      });
      if (res.ok) {
        const data = await res.json();
        const url = `${window.location.origin}/session/${sessionId}/playback?token=${data.token}`;
        setShareUrl(url);
      }
    } catch {
      // silent
    }
    setLoading(false);
  };

  const handleRevoke = async () => {
    if (!token) return;
    setRevoking(true);
    try {
      const res = await fetch('/api/share/create', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ sessionId }),
      });
      if (res.ok) {
        setShareUrl(null);
      }
    } catch {
      // silent
    }
    setRevoking(false);
  };

  const handleCopy = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div ref={ref} className="relative">
      {iconOnly ? (
        <button
          onClick={() => setOpen(!open)}
          className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
            shareUrl
              ? 'bg-rust-50 text-rust-600'
              : 'bg-cream-100 text-charcoal-600'
          }`}
          aria-label={t('playback.share')}
        >
          <Share2 className="h-4 w-4" />
        </button>
      ) : (
        <button
          onClick={() => setOpen(!open)}
          className={`btn-ghost text-xs flex items-center gap-1.5 ${
            shareUrl ? 'text-rust-600' : ''
          }`}
          title={t('playback.shareTitle')}
        >
          <Share2 className="w-3.5 h-3.5" />
          {t('playback.share')}
        </button>
      )}

      {open && (
        <div
          className="absolute top-full mt-1.5 right-0 w-72 bg-white border border-cream-300
                     rounded-xl shadow-xl z-50 p-4 origin-top-right
                     animate-[popoverIn_0.18s_ease-out]"
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-charcoal-800">
              {t('playback.shareTitle')}
            </h3>
            <button
              onClick={() => setOpen(false)}
              className="text-charcoal-400 hover:text-charcoal-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {!shareUrl ? (
            <div>
              <p className="text-xs text-charcoal-500 mb-3">
                {t('playback.shareDescription')}
              </p>
              <button
                onClick={handleCreate}
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg
                           bg-rust-500 text-white text-xs font-medium
                           hover:bg-rust-600 transition-colors disabled:opacity-60"
              >
                {loading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Link2 className="w-3.5 h-3.5" />
                )}
                {t('playback.shareCreate')}
              </button>
            </div>
          ) : (
            <div>
              {/* Share URL */}
              <div className="flex items-center gap-2 mb-3 p-2 bg-cream-50 rounded-lg border border-cream-200">
                <input
                  readOnly
                  value={shareUrl}
                  className="flex-1 text-[11px] bg-transparent text-charcoal-600 outline-none truncate"
                />
                <button
                  onClick={handleCopy}
                  className="flex-shrink-0 p-1.5 rounded-md bg-white border border-cream-300
                             hover:bg-cream-100 transition-colors"
                  title={t('playback.shareCopyLink')}
                >
                  {copied ? (
                    <CheckCheck className="w-3.5 h-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="w-3.5 h-3.5 text-charcoal-500" />
                  )}
                </button>
              </div>

              {copied && (
                <p className="text-[11px] text-emerald-600 mb-2">
                  {t('playback.shareCopied')}
                </p>
              )}

              {/* Revoke */}
              <button
                onClick={handleRevoke}
                disabled={revoking}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg
                           border border-red-200 text-red-600 text-xs font-medium
                           hover:bg-red-50 transition-colors disabled:opacity-60"
              >
                {revoking ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3 h-3" />
                )}
                {t('playback.shareRevoke')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
