/**
 * Word (.docx) 导出模块
 * 使用 docx 库在客户端生成格式优美的 Word 文档
 */
import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  ShadingType,
  convertInchesToTwip,
  ExternalHyperlink,
  PageBreak,
  Packer,
} from 'docx';
import type { SummarizeResponse } from '@/types/summary';
import type { SessionReportData } from '@/types/report';
import type { ExportTranscriptSegment } from './types';

// 主题色（与项目 cream/charcoal/rust 色系对应）
const COLORS = {
  rust: '9B4D3C',
  rustLight: 'F5E6E0',
  charcoal: '2D2D2D',
  charcoalLight: '666666',
  cream: 'F5F0EB',
  white: 'FFFFFF',
  border: 'D4C9BE',
};

function heading1(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { after: 200 },
    children: [
      new TextRun({
        text,
        color: COLORS.rust,
        bold: true,
        size: 36,
        font: 'Georgia',
      }),
    ],
  });
}

function heading2(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 150 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 1, color: COLORS.border },
    },
    children: [
      new TextRun({
        text,
        color: COLORS.charcoal,
        bold: true,
        size: 28,
        font: 'Georgia',
      }),
    ],
  });
}

function heading3(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 100 },
    children: [
      new TextRun({
        text,
        color: COLORS.charcoalLight,
        bold: true,
        size: 24,
      }),
    ],
  });
}

function bodyText(text: string, options?: { italic?: boolean; color?: string }): Paragraph {
  return new Paragraph({
    spacing: { after: 120 },
    children: [
      new TextRun({
        text,
        size: 22,
        color: options?.color ?? COLORS.charcoal,
        italics: options?.italic,
      }),
    ],
  });
}

function bulletPoint(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 60 },
    children: [
      new TextRun({ text, size: 22, color: COLORS.charcoal }),
    ],
  });
}

function metadataLine(label: string, value: string): Paragraph {
  return new Paragraph({
    spacing: { after: 60 },
    children: [
      new TextRun({ text: `${label}: `, bold: true, size: 20, color: COLORS.charcoalLight }),
      new TextRun({ text: value, size: 20, color: COLORS.charcoal }),
    ],
  });
}

function divider(): Paragraph {
  return new Paragraph({
    spacing: { before: 200, after: 200 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 2, color: COLORS.border },
    },
    children: [new TextRun({ text: '' })],
  });
}

function createDefinitionTable(definitions: Record<string, string>): Table {
  const entries = Object.entries(definitions);
  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      new TableCell({
        width: { size: 30, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.SOLID, color: COLORS.rust },
        children: [new Paragraph({
          children: [new TextRun({ text: '术语', bold: true, color: COLORS.white, size: 20 })],
        })],
      }),
      new TableCell({
        width: { size: 70, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.SOLID, color: COLORS.rust },
        children: [new Paragraph({
          children: [new TextRun({ text: '定义', bold: true, color: COLORS.white, size: 20 })],
        })],
      }),
    ],
  });

  const dataRows = entries.map(([ term, def ], i) =>
    new TableRow({
      children: [
        new TableCell({
          shading: i % 2 === 0
            ? { type: ShadingType.SOLID, color: COLORS.rustLight }
            : undefined,
          children: [new Paragraph({
            children: [new TextRun({ text: term, bold: true, size: 20, color: COLORS.charcoal })],
          })],
        }),
        new TableCell({
          shading: i % 2 === 0
            ? { type: ShadingType.SOLID, color: COLORS.rustLight }
            : undefined,
          children: [new Paragraph({
            children: [new TextRun({ text: def, size: 20, color: COLORS.charcoal })],
          })],
        }),
      ],
    })
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

/** 生成转录文本的 docx 段落 */
export function buildTranscriptParagraphs(
  segments: ExportTranscriptSegment[],
  translations: Record<string, string>,
): Paragraph[] {
  const paragraphs: Paragraph[] = [heading2('转录文本')];

  for (const seg of segments) {
    // 说话人 + 时间戳
    paragraphs.push(new Paragraph({
      spacing: { before: 120, after: 40 },
      children: [
        new TextRun({
          text: `[${seg.speaker}] `,
          bold: true,
          size: 21,
          color: COLORS.rust,
        }),
        new TextRun({
          text: seg.timestamp,
          size: 19,
          color: COLORS.charcoalLight,
          italics: true,
        }),
      ],
    }));

    // 原文
    paragraphs.push(new Paragraph({
      spacing: { after: 40 },
      indent: { left: convertInchesToTwip(0.25) },
      children: [
        new TextRun({ text: seg.text, size: 22, color: COLORS.charcoal }),
      ],
    }));

    // 翻译
    if (translations[seg.id]) {
      paragraphs.push(new Paragraph({
        spacing: { after: 80 },
        indent: { left: convertInchesToTwip(0.25) },
        shading: { type: ShadingType.SOLID, color: COLORS.cream },
        children: [
          new TextRun({
            text: `› ${translations[seg.id]}`,
            size: 20,
            color: COLORS.charcoalLight,
            italics: true,
          }),
        ],
      }));
    }
  }

  return paragraphs;
}

/** 生成总结的 docx 段落 */
export function buildSummaryParagraphs(
  summaries: SummarizeResponse[],
  report?: SessionReportData | null,
): Paragraph[] {
  const paragraphs: Paragraph[] = [heading2('内容总结')];

  // 会话报告
  if (report?.significance?.isWorthSummarizing && report.report) {
    const r = report.report;
    if (r.overview) {
      paragraphs.push(new Paragraph({
        spacing: { after: 150 },
        shading: { type: ShadingType.SOLID, color: COLORS.cream },
        indent: { left: convertInchesToTwip(0.15), right: convertInchesToTwip(0.15) },
        children: [new TextRun({ text: r.overview, size: 22, color: COLORS.charcoal, italics: true })],
      }));
    }

    if (r.sections?.length) {
      for (const section of r.sections) {
        paragraphs.push(heading3(section.title));
        for (const point of section.points ?? []) {
          paragraphs.push(bulletPoint(point));
        }
      }
    }

    if (r.conclusions?.length) {
      paragraphs.push(heading3('结论'));
      for (const c of r.conclusions) {
        paragraphs.push(bulletPoint(`✓ ${c}`));
      }
    }

    if (r.actionItems?.length) {
      paragraphs.push(heading3('待办事项'));
      for (const item of r.actionItems) {
        paragraphs.push(bulletPoint(`☐ ${item}`));
      }
    }

    if (r.keyTerms && Object.keys(r.keyTerms).length > 0) {
      paragraphs.push(heading3('关键术语'));
      paragraphs.push(createDefinitionTable(r.keyTerms) as unknown as Paragraph);
    }
  }

  // AI 摘要（不含分时标签的汇总摘要）
  const overallSummaries = summaries.filter((s) => !s.timeRange);
  if (overallSummaries.length > 0) {
    for (const summary of overallSummaries) {
      if (summary.keyPoints?.length) {
        paragraphs.push(heading3('要点'));
        for (const point of summary.keyPoints) {
          paragraphs.push(bulletPoint(point));
        }
      }
      if (summary.definitions && Object.keys(summary.definitions).length > 0) {
        paragraphs.push(heading3('术语'));
        paragraphs.push(createDefinitionTable(summary.definitions) as unknown as Paragraph);
      }
    }
  }

  return paragraphs;
}

/** 生成分时总结的 docx 段落 */
export function buildTimedSummaryParagraphs(
  summaries: SummarizeResponse[],
): Paragraph[] {
  const timed = summaries.filter((s) => s.timeRange);
  if (timed.length === 0) return [];

  const paragraphs: Paragraph[] = [heading2('分时总结')];

  for (const summary of timed) {
    paragraphs.push(new Paragraph({
      spacing: { before: 200, after: 100 },
      shading: { type: ShadingType.SOLID, color: COLORS.rustLight },
      children: [
        new TextRun({
          text: `⏱ ${summary.timeRange}`,
          bold: true,
          size: 24,
          color: COLORS.rust,
        }),
      ],
    }));

    if (summary.summary) {
      paragraphs.push(bodyText(summary.summary));
    }

    if (summary.keyPoints?.length) {
      for (const point of summary.keyPoints) {
        paragraphs.push(bulletPoint(point));
      }
    }

    if (summary.definitions && Object.keys(summary.definitions).length > 0) {
      paragraphs.push(createDefinitionTable(summary.definitions) as unknown as Paragraph);
    }

    if (summary.suggestedQuestions?.length) {
      paragraphs.push(heading3('复习问题'));
      summary.suggestedQuestions.forEach((q, i) => {
        paragraphs.push(bodyText(`${i + 1}. ${q}`));
      });
    }
  }

  return paragraphs;
}

/** 生成文档标题页 */
function buildTitleSection(
  title: string,
  date: string,
  sourceLang: string,
  targetLang: string,
): Paragraph[] {
  return [
    heading1(title),
    metadataLine('日期', new Date(date).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })),
    metadataLine('语言', `${sourceLang} → ${targetLang}`),
    metadataLine('导出时间', new Date().toLocaleString('zh-CN')),
    divider(),
  ];
}

export interface DocxExportOptions {
  title: string;
  date: string;
  sourceLang: string;
  targetLang: string;
  segments?: ExportTranscriptSegment[];
  translations?: Record<string, string>;
  summaries?: SummarizeResponse[];
  report?: SessionReportData | null;
  includeTranscript?: boolean;
  includeSummary?: boolean;
  includeTimedSummary?: boolean;
}

/** 生成完整的 docx Blob */
export async function generateDocx(options: DocxExportOptions): Promise<Blob> {
  const {
    title, date, sourceLang, targetLang,
    segments = [], translations = {}, summaries = [],
    report, includeTranscript = true, includeSummary = true, includeTimedSummary = true,
  } = options;

  const children: Paragraph[] = [
    ...buildTitleSection(title, date, sourceLang, targetLang),
  ];

  if (includeSummary) {
    children.push(...buildSummaryParagraphs(summaries, report));
    children.push(divider());
  }

  if (includeTimedSummary) {
    const timedParagraphs = buildTimedSummaryParagraphs(summaries);
    if (timedParagraphs.length > 0) {
      children.push(...timedParagraphs);
      children.push(divider());
    }
  }

  if (includeTranscript) {
    children.push(...buildTranscriptParagraphs(segments, translations));
  }

  const doc = new Document({
    creator: 'LectureLive',
    title,
    description: `Exported from LectureLive on ${new Date().toISOString()}`,
    styles: {
      default: {
        document: {
          run: {
            font: 'Microsoft YaHei',
            size: 22,
            color: COLORS.charcoal,
          },
        },
      },
    },
    sections: [{ children: children as any[] }],
  });

  return await Packer.toBlob(doc);
}
