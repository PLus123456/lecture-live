'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  Plus,
  Tag,
  Trash2,
} from 'lucide-react';

interface FolderKeyword {
  id: string;
  keyword: string;
  source: string;
  confidence: number;
  usageCount: number;
  createdAt: string;
}

function formatSource(source: string) {
  if (source === 'manual') {
    return 'Manual';
  }
  if (source.startsWith('auto:')) {
    return 'Auto';
  }
  if (source.startsWith('file:')) {
    return 'File';
  }
  return source;
}

function formatConfidence(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export default function FolderKeywordManager({
  folderId,
  folderName,
  token,
  onMutated,
}: {
  folderId: string;
  folderName: string;
  token: string | null | undefined;
  onMutated?: () => Promise<void> | void;
}) {
  const [keywords, setKeywords] = useState<FolderKeyword[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newKeyword, setNewKeyword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<'error' | 'success'>('success');

  const authHeaders = useMemo(() => {
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }, [token]);

  const setInlineMessage = useCallback((tone: 'error' | 'success', text: string | null) => {
    setMessageTone(tone);
    setMessage(text);
  }, []);

  const loadKeywords = useCallback(async () => {
    if (!token) {
      return;
    }

    setLoading(true);
    setInlineMessage('success', null);
    try {
      const res = await fetch(`/api/folders/${folderId}/keywords`, {
        headers: authHeaders,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load keywords');
      }
      setKeywords(Array.isArray(data) ? data as FolderKeyword[] : []);
    } catch (error) {
      setInlineMessage(
        'error',
        error instanceof Error ? error.message : 'Failed to load keywords'
      );
    } finally {
      setLoading(false);
    }
  }, [authHeaders, folderId, setInlineMessage, token]);

  useEffect(() => {
    void loadKeywords();
  }, [loadKeywords]);

  const handleAddKeyword = useCallback(async () => {
    if (!token || !newKeyword.trim()) {
      return;
    }

    setSaving(true);
    setInlineMessage('success', null);
    try {
      const res = await fetch(`/api/folders/${folderId}/keywords`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({ keyword: newKeyword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to add keyword');
      }

      setNewKeyword('');
      setInlineMessage('success', 'Keyword added to this folder pool.');
      await loadKeywords();
      await onMutated?.();
    } catch (error) {
      setInlineMessage(
        'error',
        error instanceof Error ? error.message : 'Failed to add keyword'
      );
    } finally {
      setSaving(false);
    }
  }, [authHeaders, folderId, loadKeywords, newKeyword, onMutated, setInlineMessage, token]);

  const handleRemoveKeyword = useCallback(async (keyword: string) => {
    if (!token) {
      return;
    }

    setSaving(true);
    setInlineMessage('success', null);
    try {
      const res = await fetch(
        `/api/folders/${folderId}/keywords?keyword=${encodeURIComponent(keyword)}`,
        {
          method: 'DELETE',
          headers: authHeaders,
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to remove keyword');
      }

      setInlineMessage('success', 'Keyword removed from this folder pool.');
      await loadKeywords();
      await onMutated?.();
    } catch (error) {
      setInlineMessage(
        'error',
        error instanceof Error ? error.message : 'Failed to remove keyword'
      );
    } finally {
      setSaving(false);
    }
  }, [authHeaders, folderId, loadKeywords, onMutated, setInlineMessage, token]);

  return (
    <section className="space-y-4 rounded-2xl border border-cream-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-charcoal-700">
            <Tag className="h-4 w-4 text-rust-500" />
            Keyword Pool
          </div>
          <p className="mt-1 text-xs text-charcoal-400">
            Warm up recognition for future sessions inside {folderName}.
          </p>
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-charcoal-300" />}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={newKeyword}
          onChange={(event) => setNewKeyword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void handleAddKeyword();
            }
          }}
          placeholder="Add a manual keyword"
          className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm text-charcoal-700 outline-none transition-colors focus:border-rust-300 focus:ring-1 focus:ring-rust-200"
        />
        <button
          onClick={() => void handleAddKeyword()}
          disabled={saving || !newKeyword.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-charcoal-800 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-charcoal-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Add
        </button>
      </div>

      {message && (
        <div
          className={`rounded-xl border px-3 py-2 text-xs ${
            messageTone === 'error'
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          }`}
        >
          {message}
        </div>
      )}

      {loading ? (
        <div className="flex min-h-[160px] items-center justify-center text-sm text-charcoal-400">
          Loading keyword pool...
        </div>
      ) : keywords.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-cream-300 bg-cream-50/50 px-4 py-6 text-center">
          <Tag className="mx-auto mb-2 h-6 w-6 text-charcoal-200" />
          <p className="text-sm text-charcoal-500">No keywords in this folder yet</p>
          <p className="mt-1 text-xs text-charcoal-300">
            Add a few manual terms now, or let completed sessions accumulate them automatically.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {keywords.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start justify-between gap-3 rounded-xl border border-cream-200 bg-cream-50/40 px-3 py-3"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-charcoal-800">
                  {entry.keyword}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-charcoal-400">
                  <span>{formatSource(entry.source)}</span>
                  <span>{formatConfidence(entry.confidence)} confidence</span>
                  <span>Used {entry.usageCount}x</span>
                </div>
              </div>
              <button
                onClick={() => void handleRemoveKeyword(entry.keyword)}
                disabled={saving}
                className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-red-200 bg-white text-red-500 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                aria-label={`Remove ${entry.keyword}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
