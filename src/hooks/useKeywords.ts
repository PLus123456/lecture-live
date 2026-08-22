'use client';

import { useCallback } from 'react';
import { useKeywordStore } from '@/stores/keywordStore';
import { useAuthStore } from '@/stores/authStore';
import type { KeywordEntry } from '@/types/llm';
import {
  normalizeKeywordKey,
  serializeExistingKeywordItems,
} from '@/lib/llm/keywordPolicy';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';

export function useKeywords() {
  const {
    keywords,
    isExtracting,
    addKeywords,
    removeKeyword,
    toggleKeyword,
    setExtracting,
    getActiveKeywords,
    clearAll,
  } = useKeywordStore();
  const token = useAuthStore((s) => s.token);
  const { t } = useI18n();

  const existingKeywordsField = useCallback(() => {
    const items = keywords.map((keyword) => keyword.text);
    const validation = serializeExistingKeywordItems(items);
    if (!validation.ok) {
      toast.error(t('keywordTab.keywordListInvalid'));
      return null;
    }
    return validation.serialized;
  }, [keywords, t]);

  const notifyRejected = useCallback(
    (count: number) => {
      if (count <= 0) return;
      toast.info(t('keywordTab.keywordLimitReached', { count }));
    },
    [t]
  );

  /** 从文本中提取关键词 */
  const extractFromText = useCallback(
    async (text: string) => {
      if (!token) return [];
      const existing = existingKeywordsField();
      if (existing === null) return [];
      setExtracting(true);
      try {
        const formData = new FormData();
        formData.append('text', text);
        if (existing) formData.append('existingKeywords', existing);

        const res = await fetch('/api/llm/extract-keywords', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });

        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const data = await res.json();

        const entries: KeywordEntry[] = data.keywords.map(
          (kw: string) => ({
            text: kw,
            source: 'llm',
            active: true,
          })
        );
        const addition = addKeywords(entries);
        notifyRejected(addition.rejected);
        return addition.added.map((entry) => entry.text);
      } finally {
        setExtracting(false);
      }
    },
    [
      token,
      existingKeywordsField,
      addKeywords,
      notifyRejected,
      setExtracting,
    ]
  );

  /** 从文件中提取关键词 */
  const extractFromFile = useCallback(
    async (file: File) => {
      if (!token) return [];
      const existing = existingKeywordsField();
      if (existing === null) return [];
      setExtracting(true);
      try {
        const formData = new FormData();
        formData.append('file', file);
        if (existing) formData.append('existingKeywords', existing);

        const res = await fetch('/api/llm/extract-keywords', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });

        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const data = await res.json();

        const entries: KeywordEntry[] = data.keywords.map(
          (kw: string) => ({
            text: kw,
            source: file.name,
            active: true,
          })
        );
        const addition = addKeywords(entries);
        notifyRejected(addition.rejected);
        return addition.added.map((entry) => entry.text);
      } finally {
        setExtracting(false);
      }
    },
    [
      token,
      existingKeywordsField,
      addKeywords,
      notifyRejected,
      setExtracting,
    ]
  );

  /** 手动批量添加；返回实际入库的词，调用方不应继续注入被拒项。 */
  const addManualKeywords = useCallback(
    (texts: string[]) => {
      const addition = addKeywords(
        texts.map((text) => ({ text, source: 'manual', active: true }))
      );
      notifyRejected(addition.rejected);
      const stored = new Map(
        useKeywordStore
          .getState()
          .keywords.map((entry) => [normalizeKeywordKey(entry.text), entry.text])
      );
      const seen = new Set<string>();
      return texts.flatMap((text) => {
        const key = normalizeKeywordKey(text);
        const accepted = stored.get(key);
        if (!accepted || seen.has(key)) return [];
        seen.add(key);
        return [accepted];
      });
    },
    [addKeywords, notifyRejected]
  );

  return {
    keywords,
    isExtracting,
    extractFromText,
    extractFromFile,
    addManualKeywords,
    removeKeyword,
    toggleKeyword,
    getActiveKeywords,
    clearAll,
  };
}
