import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExportModal from '@/components/ExportModal';
import type { ExportTranscriptSegment } from '@/lib/export/types';
import type { SummarizeResponse } from '@/types/summary';

vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (state: { token: string | null }) => unknown) =>
    selector({ token: 'token-1' }),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (key === 'exportModal.title') return '导出';
      if (key === 'exportModal.stepContent') return '选择导出内容';
      if (key === 'exportModal.stepFormat') return '选择导出格式';
      if (key === 'exportModal.stepMode') return '文档模式';
      if (key === 'exportModal.contentTranscript') return '转录文本';
      if (key === 'exportModal.contentTranscriptDesc') return '完整的语音转录与翻译';
      if (key === 'exportModal.contentSummary') return '内容总结';
      if (key === 'exportModal.contentSummaryDesc') return '会话报告与 AI 摘要';
      if (key === 'exportModal.contentTimedSummary') return '分时总结';
      if (key === 'exportModal.contentTimedSummaryDesc') return '按时间段划分的摘要';
      if (key === 'exportModal.contentRecording') return '录音文件';
      if (key === 'exportModal.contentRecordingDesc') return '原始音频录制文件';
      if (key === 'exportModal.modeSingle') return '合并为一个文档';
      if (key === 'exportModal.modeSingleDesc') return '所有内容整合到一起';
      if (key === 'exportModal.modeSeparate') return '各自独立文档';
      if (key === 'exportModal.modeSeparateDesc') return '每项内容单独一个文件';
      if (key === 'exportModal.singleFile') return '将下载为单个文件';
      if (key === 'exportModal.loadingData') return '正在加载当前会话的导出数据…';
      if (key === 'exportModal.srtHint') return 'SRT 仅支持导出转录文本，可与录音一起下载';
      if (key === 'common.cancel') return '取消';
      if (key === 'common.download') return '下载';
      if (key === 'session.defaultTitle') return '默认标题';
      return params ? `${key}:${JSON.stringify(params)}` : key;
    },
  }),
}));

function createSegment(): ExportTranscriptSegment {
  return {
    id: 'seg-1',
    speaker: 'Teacher',
    language: 'en',
    text: 'Transcript body',
    startMs: 0,
    endMs: 2_000,
    isFinal: true,
    confidence: 0.99,
    timestamp: '00:00:00',
  };
}

function createSummary(): SummarizeResponse {
  return {
    timestamp: 1,
    summary: 'Summary body',
    keyPoints: ['Summary point'],
  };
}

describe('ExportModal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('空 override 不会覆盖服务端导出数据，且 false 的 hasRecording 不会压掉服务端结果', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        title: '服务端标题',
        sourceLang: 'ja',
        targetLang: 'en',
        segments: [createSegment()],
        translations: { 'seg-1': '翻译正文' },
        summaries: [createSummary()],
        report: null,
        hasRecording: true,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ExportModal
        isOpen
        onClose={() => {}}
        sessionTitle=""
        sessionId="session-1"
        segments={[]}
        translations={{}}
        summaries={[]}
        hasRecording={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('服务端标题')).toBeInTheDocument();
      expect(screen.getByText('转录文本').closest('button')).toBeEnabled();
      expect(screen.getByText('内容总结').closest('button')).toBeEnabled();
      expect(screen.getByText('录音文件').closest('button')).toBeEnabled();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/export-data', {
      headers: { Authorization: 'Bearer token-1' },
    });
  });

  it('选择 SRT 后会自动收敛为仅转录文本，并禁用 summary 类内容', async () => {
    const user = userEvent.setup();

    render(
      <ExportModal
        isOpen
        onClose={() => {}}
        sessionTitle="课程标题"
        segments={[createSegment()]}
        translations={{ 'seg-1': '翻译正文' }}
        summaries={[createSummary()]}
      />
    );

    expect(screen.getByText('文档模式')).toBeInTheDocument();

    await user.click(screen.getByText('SRT 字幕').closest('button') as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.queryByText('文档模式')).not.toBeInTheDocument();
      expect(screen.getByText('内容总结').closest('button')).toBeDisabled();
      expect(screen.getByText('SRT 仅支持导出转录文本，可与录音一起下载')).toBeInTheDocument();
    });
  });
});
