import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TranscriptPanel from '@/components/TranscriptPanel';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useTranslationStore } from '@/stores/translationStore';

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (key === 'transcriptPanel.translating') return '翻译中…';
      if (key === 'transcriptPanel.segmentCount') return String(params?.n ?? 0);
      if (key === 'transcriptPanel.title') return 'Transcript';
      if (key === 'transcriptPanel.empty') return '空';
      if (key === 'transcriptPanel.scrollToLatest') return '最新';
      return key;
    },
  }),
}));

describe('TranscriptPanel', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useTranscriptStore.getState().clearAll();
    useTranslationStore.getState().clearAll();
  });

  it('将 preview 的 final 与 non-final 部分渲染成不同样式', () => {
    useTranscriptStore.getState().updatePreview({
      finalText: '稳定部分',
      nonFinalText: '抖动尾巴',
    });
    useTranscriptStore.getState().updatePreviewTranslation({
      finalText: 'stable part',
      nonFinalText: ' shaky tail',
      state: 'streaming',
      sourceLanguage: 'zh',
    });

    render(<TranscriptPanel showHeader={false} />);

    expect(screen.getByText('稳定部分')).toHaveClass('text-charcoal-600');
    expect(screen.getByText('抖动尾巴')).toHaveClass('text-charcoal-400');
    expect(screen.getByText('stable part')).toHaveClass('text-rust-700');
    expect(screen.getByText(/shaky tail/)).toHaveClass('text-rust-500');
  });

  it('在翻译还没出字时显示等待态', () => {
    useTranscriptStore.getState().updatePreview({
      finalText: '',
      nonFinalText: '正在说话',
    });
    useTranscriptStore.getState().updatePreviewTranslation({
      finalText: '',
      nonFinalText: '',
      state: 'waiting',
      sourceLanguage: 'zh',
    });

    render(<TranscriptPanel showHeader={false} />);

    expect(screen.getByText('翻译中…')).toBeInTheDocument();
  });
});
