import { describe, expect, it, vi } from 'vitest';
import {
  buildExportPlan,
  executeExport,
  normalizeContentsForFormat,
  type ExportOptions,
} from '@/lib/export/clientExport';

function createExportOptions(
  overrides?: Partial<ExportOptions>
): ExportOptions {
  return {
    contents: ['transcript'],
    format: 'md',
    documentMode: 'single',
    payload: {
      title: 'Lecture Export',
      date: new Date('2026-04-02T12:00:00Z').toISOString(),
      sourceLang: 'en',
      targetLang: 'zh',
      segments: [],
      translations: {},
      summaries: [],
      report: null,
    },
    ...overrides,
  };
}

describe('client export helpers', () => {
  it('按真实下载行为规划 PDF 与 ZIP 提示', () => {
    expect(
      buildExportPlan(['summary', 'timedSummary'], 'pdf', 'separate')
    ).toEqual({
      textContents: ['summary', 'timedSummary'],
      includeRecording: false,
      textDownloadFileCount: 2,
      downloadFileCount: 2,
      usesPrintDialog: false,
      willZip: true,
    });

    expect(
      buildExportPlan(['summary', 'timedSummary', 'recording'], 'pdf', 'separate')
    ).toEqual({
      textContents: ['summary', 'timedSummary'],
      includeRecording: true,
      textDownloadFileCount: 2,
      downloadFileCount: 3,
      usesPrintDialog: false,
      willZip: true,
    });
  });

  it('JSON 分开导出时按 summary 和 timed summary 分别计数', () => {
    expect(
      buildExportPlan(['summary', 'timedSummary'], 'json', 'separate')
    ).toEqual({
      textContents: ['summary', 'timedSummary'],
      includeRecording: false,
      textDownloadFileCount: 2,
      downloadFileCount: 2,
      usesPrintDialog: false,
      willZip: true,
    });
  });

  it('SRT 会把文本内容收敛为仅 transcript', () => {
    expect(
      normalizeContentsForFormat(['transcript', 'summary', 'timedSummary', 'recording'], 'srt')
    ).toEqual(['transcript', 'recording']);

    expect(
      buildExportPlan(['transcript', 'summary', 'timedSummary'], 'srt', 'separate')
    ).toEqual({
      textContents: ['transcript'],
      includeRecording: false,
      textDownloadFileCount: 1,
      downloadFileCount: 1,
      usesPrintDialog: false,
      willZip: false,
    });
  });

  it('请求录音但拉取失败时抛错，而不是静默成功', async () => {
    const fetchRecording = vi.fn().mockResolvedValue(null as Blob | null);

    await expect(
      executeExport(
        createExportOptions({
          contents: ['recording'],
          fetchRecording,
        })
      )
    ).rejects.toThrow('Recording download failed');

    expect(fetchRecording).toHaveBeenCalledTimes(1);
  });
});
