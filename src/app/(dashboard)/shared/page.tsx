'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Eye,
  ExternalLink,
  Link2,
  Loader2,
  Radio,
  Share2,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useSharedLinksStore } from '@/stores/sharedLinksStore';

interface SharedSessionLink {
  id: string;
  token: string;
  isLive: boolean;
  createdAt: string;
  expiresAt: string | null;
  url: string;
  session: {
    id: string;
    title: string;
    status: string;
    createdAt: string;
    sourceLang: string;
    targetLang: string;
  };
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SharedPage() {
  const isMobile = useIsMobile();
  const { token } = useAuth();
  const viewedLinks = useSharedLinksStore((s) => s.viewedLinks);
  const [links, setLinks] = useState<SharedSessionLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    fetch('/api/share/create', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        const data = await res.json().catch(() => []);
        if (!res.ok) {
          throw new Error(data.error || 'Failed to load shared links');
        }
        setLinks(Array.isArray(data) ? data : []);
      })
      .catch((loadError) => {
        setError(
          loadError instanceof Error ? loadError.message : 'Failed to load shared links'
        );
      })
      .finally(() => {
        setLoading(false);
      });
  }, [token]);

  const activeLinks = useMemo(
    () =>
      links.filter(
        (link) => link.isLive && (!link.expiresAt || new Date(link.expiresAt) > new Date())
      ),
    [links]
  );

  const expiredLinks = useMemo(
    () =>
      links.filter(
        (link) => !link.isLive || (link.expiresAt ? new Date(link.expiresAt) <= new Date() : false)
      ),
    [links]
  );

  const copyLink = async (link: SharedSessionLink) => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopiedId(link.id);
      window.setTimeout(() => setCopiedId(null), 1600);
    } catch {
      setCopiedId(null);
    }
  };

  return (
    <div className={isMobile ? 'p-4 pb-28' : 'p-8 lg:p-12'}>
      <h1 className="font-serif text-2xl font-bold text-charcoal-800 mb-2 animate-fade-in-up">
        Shared
      </h1>
      <p className="mb-6 text-sm text-charcoal-400 animate-fade-in-up stagger-1">
        Track your live share links and jump back into active viewer sessions.
      </p>

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className={`grid gap-6 ${isMobile ? 'grid-cols-1' : 'xl:grid-cols-2'}`}>
        <section className="rounded-2xl border border-cream-200 bg-white p-5 shadow-sm animate-fade-in-up stagger-2">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-charcoal-700">
            <Radio className="h-4 w-4 text-rust-500" />
            Shared By Me
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12 text-charcoal-400">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading share links...
            </div>
          ) : activeLinks.length === 0 && expiredLinks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-cream-300 bg-cream-50/70 px-4 py-10 text-center animate-fade-in">
              <Share2 className="mx-auto mb-3 h-8 w-8 text-charcoal-200 animate-breathe" />
              <p className="text-sm text-charcoal-500">No shared links yet</p>
              <p className="mt-1 text-xs text-charcoal-400">
                Start a live share from any recording session and it will show up here.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {activeLinks.length > 0 && (
                <div>
                  <div className="mb-2 text-[11px] uppercase tracking-[0.16em] text-charcoal-400">
                    Active
                  </div>
                  <div className="space-y-3">
                    {activeLinks.map((link, index) => (
                      <article
                        key={link.id}
                        className="rounded-xl border border-cream-200 bg-cream-50/50 p-4 animate-list-item-in card-hover-lift"
                        style={{ animationDelay: `${index * 0.08}s` }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h2 className="text-sm font-semibold text-charcoal-800">
                              {link.session.title}
                            </h2>
                            <p className="mt-1 text-[11px] text-charcoal-400">
                              {link.session.sourceLang.toUpperCase()} → {link.session.targetLang.toUpperCase()} · {link.session.status}
                            </p>
                          </div>
                          <span className="rounded-full bg-rust-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-rust-700">
                            Live
                          </span>
                        </div>

                        <div className="mt-3 text-[11px] text-charcoal-400">
                          Created {formatDate(link.createdAt)}
                          {link.expiresAt ? ` · Expires ${formatDate(link.expiresAt)}` : ' · No expiry'}
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            onClick={() => void copyLink(link)}
                            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-cream-300 bg-white px-3 py-2 text-xs text-charcoal-600 transition-colors hover:bg-cream-50"
                          >
                            <Link2 className="h-3.5 w-3.5" />
                            {copiedId === link.id ? 'Copied' : 'Copy Link'}
                          </button>
                          <a
                            href={link.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-rust-200 bg-rust-50 px-3 py-2 text-xs text-rust-700 transition-colors hover:bg-rust-100"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Open Viewer
                          </a>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              )}

              {expiredLinks.length > 0 && (
                <div>
                  <div className="mb-2 text-[11px] uppercase tracking-[0.16em] text-charcoal-400">
                    Inactive
                  </div>
                  <div className="space-y-2">
                    {expiredLinks.map((link) => (
                      <div
                        key={link.id}
                        className="rounded-xl border border-cream-200 px-4 py-3 text-sm text-charcoal-500"
                      >
                        <div className="font-medium text-charcoal-700">{link.session.title}</div>
                        <div className="mt-1 text-[11px] text-charcoal-400">
                          Created {formatDate(link.createdAt)}
                          {link.expiresAt ? ` · Ended ${formatDate(link.expiresAt)}` : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-cream-200 bg-white p-5 shadow-sm animate-fade-in-up stagger-3">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-charcoal-700">
            <Eye className="h-4 w-4 text-rust-500" />
            Shared With Me
          </div>

          {viewedLinks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-cream-300 bg-cream-50/70 px-4 py-10 text-center animate-fade-in">
              <Eye className="mx-auto mb-3 h-8 w-8 text-charcoal-200 animate-breathe" />
              <p className="text-sm text-charcoal-500">No viewer links opened yet</p>
              <p className="mt-1 text-xs text-charcoal-400">
                Open any received live-share URL and it will show up here for quick access.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {viewedLinks.map((link) => (
                <article
                  key={link.token}
                  className="rounded-xl border border-cream-200 bg-cream-50/50 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold text-charcoal-800">
                        {link.title}
                      </h2>
                      <p className="mt-1 text-[11px] text-charcoal-400">
                        {link.sourceLang.toUpperCase()} → {link.targetLang.toUpperCase()} · {link.status}
                      </p>
                    </div>
                    <span className="rounded-full bg-cream-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-charcoal-500">
                      Viewed
                    </span>
                  </div>

                  <div className="mt-3 text-[11px] text-charcoal-400">
                    Opened {formatDate(link.viewedAt)}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => void navigator.clipboard.writeText(link.url)}
                      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-cream-300 bg-white px-3 py-2 text-xs text-charcoal-600 transition-colors hover:bg-cream-50"
                    >
                      <Link2 className="h-3.5 w-3.5" />
                      Copy Link
                    </button>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-rust-200 bg-rust-50 px-3 py-2 text-xs text-rust-700 transition-colors hover:bg-rust-100"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open Viewer
                    </a>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
