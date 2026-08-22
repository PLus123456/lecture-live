import { describe, expect, it } from 'vitest';

import {
  parseSessionReportResult,
  parseTitleGenerationResult,
} from '@/lib/llm/security';

const REPORT_FALLBACK = {
  sessionTitle: 'fallback title',
  date: '2026-08-22',
  duration: '1h',
};

/**
 * L38②：`stripJsonCodeFences` 老实现是 `raw.replace(/```json|```/gi, '')` ——
 * **全局**删掉所有围栏。响应正文的 JSON 字符串值里完全可能合法出现 ```（讲座讲到
 * markdown、转录里贴了代码块），全局删除会把正文改写掉。
 */
describe('stripJsonCodeFences（L38② 只剥包裹整体的围栏）', () => {
  it('正文 JSON 字符串值里的 ``` 必须原样保留', () => {
    const raw = JSON.stringify({
      title: 'T',
      topic: 'x',
      participants: ['P'],
      date: '2026-08-22',
      duration: '1h',
      overview: '老师说：用 ```python 包住代码块```，注意缩进',
      sections: [],
      conclusions: [],
      actionItems: [],
      keyTerms: {},
    });

    const report = parseSessionReportResult(raw, REPORT_FALLBACK);
    expect(report.overview).toContain('```python');
    expect(report.overview).toContain('包住代码块```');
  });

  it('围栏包裹整体时照常剥掉（老行为不能退化）', () => {
    const payload = JSON.stringify({
      title: 'FENCED',
      topic: 'x',
      participants: ['P'],
      date: '2026-08-22',
      duration: '1h',
      overview: 'ok',
      sections: [],
      conclusions: [],
      actionItems: [],
      keyTerms: {},
    });

    expect(
      parseSessionReportResult('```json\n' + payload + '\n```', REPORT_FALLBACK)
        .title
    ).toBe('FENCED');
    expect(
      parseSessionReportResult('```\n' + payload + '\n```', REPORT_FALLBACK).title
    ).toBe('FENCED');
  });

  it('围栏包裹 + 正文里也有围栏：剥外层、留内层', () => {
    const payload = JSON.stringify({
      title: 'T',
      topic: 'x',
      participants: ['P'],
      date: '2026-08-22',
      duration: '1h',
      overview: '示例：```js\\nfoo()\\n```',
      sections: [],
      conclusions: [],
      actionItems: [],
      keyTerms: {},
    });
    const report = parseSessionReportResult(
      '```json\n' + payload + '\n```',
      REPORT_FALLBACK
    );
    expect(report.overview).toContain('```js');
  });

  it('只有开头围栏、没有收尾（响应被截断）时尽力剥开头那行', () => {
    const payload = JSON.stringify({
      zh: '标题',
      en: 'Title',
    });
    expect(parseTitleGenerationResult('```json\n' + payload).zh).toBe('标题');
  });
});

/**
 * L40：`Session.title` 是 VARCHAR(191)，此前 zh/en **完全不截断**（其余字段全都走
 * toBoundedString），模型吐出超长标题 → prisma.session.update 抛错 → 整个标题任务失败。
 */
describe('parseTitleGenerationResult（L40 标题长度上限）', () => {
  it('超长标题被截断到落库上限以内', () => {
    const raw = JSON.stringify({
      zh: '很'.repeat(500),
      en: 'word '.repeat(300),
    });
    const result = parseTitleGenerationResult(raw);

    expect(result.zh.length).toBeLessThanOrEqual(120);
    expect(result.en.length).toBeLessThanOrEqual(120);
    // 191 是 MySQL VARCHAR 上限，必须留有余量
    expect(result.zh.length).toBeLessThan(191);
    expect(result.en.length).toBeLessThan(191);
  });

  it('常规长度标题原样返回（不误伤）', () => {
    const raw = JSON.stringify({
      zh: '机器学习导论第三讲：梯度下降',
      en: 'Intro to ML Lecture 3: Gradient Descent',
    });
    const result = parseTitleGenerationResult(raw);
    expect(result.zh).toBe('机器学习导论第三讲：梯度下降');
    expect(result.en).toBe('Intro to ML Lecture 3: Gradient Descent');
  });
});
