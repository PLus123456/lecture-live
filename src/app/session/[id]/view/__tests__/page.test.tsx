import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useTranslationStore } from '@/stores/translationStore';

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: () => null,
  }),
}));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (key === 'viewer.liveTranscript') return '实时转录';
      if (key === 'transcriptPanel.segmentCount') return String(params?.n ?? 0);
      if (key === 'translationPanel.translating') return '翻译中…';
      if (key === 'viewer.waitTranscript') return '等待转录';
      if (key === 'viewer.scrollToLatest') return '跳到最新';
      return key;
    },
    locale: 'zh',
  }),
}));

import { ViewerTranscriptPanel } from '@/app/session/[id]/view/page';

describe('ViewerTranscriptPanel', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useTranscriptStore.getState().clearAll();
    useTranslationStore.getState().clearAll();
  });

  it('观众端 preview 翻译只让 non-final 尾巴变淡', () => {
    useTranscriptStore.getState().updatePreview({
      finalText: '稳定原文',
      nonFinalText: '尾巴',
    });
    useTranscriptStore.getState().updatePreviewTranslation({
      finalText: '稳定翻译',
      nonFinalText: ' 未定尾巴',
      state: 'streaming',
      sourceLanguage: 'zh',
    });

    render(<ViewerTranscriptPanel isLive />);

    const stableTranslation = screen.getByText('稳定翻译');
    const uncertainTail = screen.getByText(/未定尾巴/);

    expect(stableTranslation).toHaveClass('text-rust-700');
    expect(uncertainTail).toHaveClass('text-rust-500');
    expect(stableTranslation.parentElement).not.toHaveClass('opacity-70');
  });
});
