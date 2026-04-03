import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import {
  executeExport,
  type ExportOptions,
  type ExportPayload,
} from '@/lib/export/clientExport';

function createPayload(): ExportPayload {
  return {
    title: 'Lecture Export',
    date: new Date('2026-04-02T12:00:00Z').toISOString(),
    sourceLang: 'en',
    targetLang: 'zh',
    segments: [
      {
        id: 'seg-1',
        speaker: 'Teacher',
        language: 'en',
        text: 'This transcript should only appear when transcript is selected.',
        startMs: 0,
        endMs: 5_000,
        isFinal: true,
        confidence: 0.98,
        timestamp: '00:00:00',
      },
    ],
    translations: {
      'seg-1': '这段转录只应在导出转录时出现。',
    },
    summaries: [
      {
        timestamp: 1,
        summary: '普通总结正文：这是课程的总体概览。',
        keyPoints: ['普通总结要点 A'],
        definitions: {
          Hook: '一种 React 能力',
        },
        suggestedQuestions: ['普通总结问题 1'],
      },
      {
        timestamp: 2,
        timeRange: '00:00-05:00',
        summary: '分时总结正文：这一段讲了解析流程。',
        keyPoints: ['分时总结要点 B'],
        definitions: {
          Parser: '负责把输入转换成结构化结果的模块',
        },
        suggestedQuestions: ['分时总结问题 1'],
      },
    ],
    report: {
      significance: {
        score: 0.92,
        reason: '内容足够完整',
        isWorthSummarizing: true,
      },
      generatedAt: new Date('2026-04-02T12:30:00Z').toISOString(),
      report: {
        title: 'Lecture Report',
        topic: '导出流程',
        participants: ['Teacher'],
        date: '2026-04-02',
        duration: '5 minutes',
        overview: '报告概览：这一讲覆盖了导出链路。',
        sections: [
          {
            title: '第一部分',
            points: ['报告要点 1'],
          },
        ],
        conclusions: ['报告结论 1'],
        actionItems: ['报告待办 1'],
        keyTerms: {
          Exporter: '负责生成文件的模块',
        },
      },
    },
  };
}

function createExportOptions(overrides?: Partial<ExportOptions>): ExportOptions {
  return {
    contents: ['summary'],
    format: 'md',
    documentMode: 'single',
    payload: createPayload(),
    ...overrides,
  };
}

async function captureDownloadedText(options: ExportOptions) {
  const blobs = new Map<string, Blob>();
  let downloadUrl: string | null = null;
  let downloadName: string | null = null;
  const realCreateElement = document.createElement.bind(document);
  const createObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const revokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob) => {
      const url = `blob:mock-${blobs.size}`;
      blobs.set(url, blob);
      return url;
    }),
  });

  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });

  const createElementSpy = vi
    .spyOn(document, 'createElement')
    .mockImplementation(((tagName: string) => {
      const element = realCreateElement(tagName);
      if (tagName.toLowerCase() === 'a') {
        const anchor = element as HTMLAnchorElement;
        Object.defineProperty(anchor, 'click', {
          configurable: true,
          value: vi.fn(() => {
            downloadUrl = anchor.getAttribute('href');
            downloadName = anchor.download;
          }),
        });
      }
      return element;
    }) as typeof document.createElement);

  try {
    await executeExport(options);
  } finally {
    createElementSpy.mockRestore();

    if (createObjectURLDescriptor) {
      Object.defineProperty(URL, 'createObjectURL', createObjectURLDescriptor);
    } else {
      delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    }

    if (revokeObjectURLDescriptor) {
      Object.defineProperty(URL, 'revokeObjectURL', revokeObjectURLDescriptor);
    } else {
      delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    }
  }

  if (!downloadUrl || !downloadName) {
    throw new Error('未捕获到下载行为');
  }

  const blob = blobs.get(downloadUrl);
  if (!blob) {
    throw new Error('未捕获到下载内容');
  }

  return {
    blob,
    filename: downloadName,
    text: await blob.text(),
  };
}

describe('client export single file', () => {
  it('单文件 JSON 只导出用户选中的分时总结', async () => {
    const { filename, text } = await captureDownloadedText(
      createExportOptions({
        contents: ['timedSummary'],
        format: 'json',
      }),
    );

    expect(filename).toMatch(/\.json$/);

    const data = JSON.parse(text) as {
      summaries: Array<{ timeRange?: string; summary?: string }>;
      segments: unknown[];
      report?: unknown;
    };

    expect(data.segments).toEqual([]);
    expect(data.report).toBeUndefined();
    expect(data.summaries).toEqual([
      expect.objectContaining({
        timeRange: '00:00-05:00',
        summary: '分时总结正文：这一段讲了解析流程。',
      }),
    ]);
  });

  it('单文件 Markdown 只导出普通总结时会保留正文并去掉 Transcript 区块', async () => {
    const { filename, text } = await captureDownloadedText(
      createExportOptions({
        contents: ['summary'],
        format: 'md',
      }),
    );

    expect(filename).toMatch(/\.md$/);
    expect(text).toContain('## AI Summary');
    expect(text).toContain('普通总结正文：这是课程的总体概览。');
    expect(text).not.toContain('分时总结正文：这一段讲了解析流程。');
    expect(text).not.toContain('## Transcript');
  });

  it('单文件 Markdown 只导出分时总结时会保留分时正文并过滤普通总结', async () => {
    const { text } = await captureDownloadedText(
      createExportOptions({
        contents: ['timedSummary'],
        format: 'md',
      }),
    );

    expect(text).toContain('## AI Summary');
    expect(text).toContain('### 00:00-05:00');
    expect(text).toContain('分时总结正文：这一段讲了解析流程。');
    expect(text).not.toContain('普通总结正文：这是课程的总体概览。');
    expect(text).not.toContain('## Transcript');
  });

  it('分开导出的 Markdown 分时总结会补齐术语与复习问题', async () => {
    const { blob, filename } = await captureDownloadedText(
      createExportOptions({
        contents: ['summary', 'timedSummary'],
        format: 'md',
        documentMode: 'separate',
      }),
    );

    expect(filename).toMatch(/\.zip$/);

    const zip = await JSZip.loadAsync(blob);
    const timedSummaryEntry = zip.file(/分时总结\.md$/)[0];

    if (!timedSummaryEntry) {
      throw new Error('未找到分时总结 Markdown 文件');
    }

    const text = await timedSummaryEntry.async('text');
    expect(text).toContain('### 术语');
    expect(text).toContain('Parser');
    expect(text).toContain('### 复习问题');
    expect(text).toContain('1. 分时总结问题 1');
  });

  it('TXT 内容总结会补齐报告中的结论、待办和关键术语', async () => {
    const { text } = await captureDownloadedText(
      createExportOptions({
        contents: ['summary'],
        format: 'txt',
      }),
    );

    expect(text).toContain('结论：');
    expect(text).toContain('• 报告结论 1');
    expect(text).toContain('待办事项：');
    expect(text).toContain('□ 报告待办 1');
    expect(text).toContain('关键术语：');
    expect(text).toContain('Exporter: 负责生成文件的模块');
  });

  it('TXT 分时总结会补齐术语与复习问题', async () => {
    const { text } = await captureDownloadedText(
      createExportOptions({
        contents: ['timedSummary'],
        format: 'txt',
      }),
    );

    expect(text).toContain('术语：');
    expect(text).toContain('Parser: 负责把输入转换成结构化结果的模块');
    expect(text).toContain('复习问题：');
    expect(text).toContain('1. 分时总结问题 1');
  });
});
