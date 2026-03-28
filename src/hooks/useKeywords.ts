'use client';

import { useCallback } from 'react';
import { useKeywordStore } from '@/stores/keywordStore';
import { useAuthStore } from '@/stores/authStore';
import type { KeywordEntry } from '@/types/llm';

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

  /** 从文本中提取关键词 */
  const extractFromText = useCallback(
    async (text: string) => {
      if (!token) return [];
      setExtracting(true);
      try {
        const formData = new FormData();
        formData.append('text', text);
        const existing = keywords.map((k) => k.text).join(', ');
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
        addKeywords(entries);
        return data.keywords as string[];
      } finally {
        setExtracting(false);
      }
    },
    [token, keywords, addKeywords, setExtracting]
  );

  /** 从文件中提取关键词 */
  const extractFromFile = useCallback(
    async (file: File) => {
      if (!token) return [];
      setExtracting(true);
      try {
        const formData = new FormData();
        formData.append('file', file);
        const existing = keywords.map((k) => k.text).join(', ');
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
        addKeywords(entries);
        return data.keywords as string[];
      } finally {
        setExtracting(false);
      }
    },
    [token, keywords, addKeywords, setExtracting]
  );

  /** 手动添加关键词 */
  const addManualKeyword = useCallback(
    (text: string) => {
      addKeywords([{ text, source: 'manual', active: true }]);
    },
    [addKeywords]
  );

  return {
    keywords,
    isExtracting,
    extractFromText,
    extractFromFile,
    addManualKeyword,
    removeKeyword,
    toggleKeyword,
    getActiveKeywords,
    clearAll,
  };
}
