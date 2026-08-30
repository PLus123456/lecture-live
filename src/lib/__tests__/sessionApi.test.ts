import { describe, expect, it } from 'vitest';
import {
  admitPersistedTranscriptBundle,
  admitSessionFinalizePayload,
  admitTranscriptDraftPayload,
  isStorageCategoryValue,
  normalizeExportFormat,
  normalizeLanguageCode,
  normalizeOptionalString,
  normalizeSessionAudioSource,
  normalizeSessionRegion,
  readBoundedSessionJson,
  SESSION_TRANSCRIPT_LIMITS,
  SessionTranscriptPayloadError,
  validatePersistedTranscriptBundle,
} from '@/lib/sessionApi';

function segment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'seg-1',
    sessionIndex: 0,
    speaker: 'Speaker 1',
    language: 'en',
    text: 'A normal transcript segment.',
    globalStartMs: 0,
    globalEndMs: 1_000,
    startMs: 0,
    endMs: 1_000,
    isFinal: true,
    confidence: 0.98,
    timestamp: '00:00:00',
    ...overrides,
  };
}

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    segments: [segment()],
    summaries: [],
    translations: { 'seg-1': '正常译文' },
    ...overrides,
  };
}

describe('session api helpers', () => {
  it('规范化音频源、区域和语言', () => {
    expect(normalizeSessionAudioSource('mic')).toBe('microphone');
    expect(normalizeSessionAudioSource('system_audio')).toBe('system_audio');
    expect(normalizeSessionRegion('EU')).toBe('eu');
    // 'zh-cn' 不在有效语言列表中（列表使用 ISO 639-1: 'zh'），回退到 fallback
    expect(normalizeLanguageCode('  ZH-CN  ', 'en')).toBe('en');
    expect(normalizeLanguageCode('  ZH  ', 'en')).toBe('zh');
    expect(normalizeLanguageCode('invalid-lang', 'en')).toBe('en');
    expect(normalizeSessionAudioSource({})).toBeNull();
    expect(normalizeSessionRegion(123)).toBeNull();
  });

  it('验证 transcript bundle 结构', () => {
    expect(
      validatePersistedTranscriptBundle({
        segments: [],
        summaries: [],
        translations: { a: 'b' },
      })
    ).toEqual({
      segments: [],
      summaries: [],
      translations: { a: 'b' },
    });

    expect(validatePersistedTranscriptBundle({ segments: [] })).toBeNull();
    expect(
      validatePersistedTranscriptBundle({
        segments: [],
        summaries: [],
        translations: { a: 1 },
      })
    ).toBeNull();
    expect(validatePersistedTranscriptBundle(null)).toBeNull();
  });

  it('规范化导出格式', () => {
    expect(normalizeExportFormat('markdown')).toBe('markdown');
    expect(normalizeExportFormat('pdf')).toBeNull();
    expect(normalizeExportFormat(123)).toBeNull();
  });

  it('处理可选字符串和存储分类判断', () => {
    expect(normalizeOptionalString('  title  ', 4)).toBe('titl');
    expect(normalizeOptionalString('   ', 10)).toBeNull();
    expect(normalizeOptionalString(42, 10)).toBeNull();
    expect(isStorageCategoryValue('recordings')).toBe(true);
    expect(isStorageCategoryValue('reports')).toBe(false);
  });

  it('严格接收正常 transcript/draft/finalize 载荷', () => {
    expect(admitPersistedTranscriptBundle(bundle())).toEqual(bundle());
    expect(
      admitTranscriptDraftPayload(
        {
          ...bundle(),
          clientTs: 123,
          pausedAt: null,
          totalDurationMs: 1_000,
          summaryRunningContext: 'context',
        },
        999
      )
    ).toMatchObject({ clientTs: 123, totalDurationMs: 1_000 });
    expect(
      admitSessionFinalizePayload({
        ...bundle(),
        durationMs: 1_000,
        title: ' Lecture ',
      })
    ).toMatchObject({
      clientBundle: bundle(),
      clientDurationMs: 1_000,
      clientTitle: 'Lecture',
    });
    expect(admitSessionFinalizePayload({ durationMs: 1_000 })).toEqual({
      clientBundle: null,
      clientDurationMs: 1_000,
    });
  });

  it('有界兼容旧时间别名和 legacy summary，并规范化后再落盘', () => {
    const legacySegment = segment();
    delete (legacySegment as { globalStartMs?: unknown }).globalStartMs;
    delete (legacySegment as { globalEndMs?: unknown }).globalEndMs;
    delete (legacySegment as { sessionIndex?: unknown }).sessionIndex;
    const admitted = admitPersistedTranscriptBundle(
      bundle({
        segments: [legacySegment],
        summaries: [
          {
            keyPoints: ['bounded'],
            definitions: { quota: 'resource limit' },
            summary: 'Legacy summary',
            suggestedQuestions: ['Why?'],
            timeRange: '00:00-00:01',
            timestamp: 1,
          },
        ],
      })
    );

    expect(admitted.segments[0]).toMatchObject({
      startMs: 0,
      globalStartMs: 0,
      endMs: 1_000,
      globalEndMs: 1_000,
      sessionIndex: 0,
    });
    expect(admitted.summaries[0]).toMatchObject({
      keyPoints: ['bounded'],
      timestamp: 1,
    });
  });

  it('拒绝互相矛盾的时间别名', () => {
    expect(() =>
      admitPersistedTranscriptBundle(
        bundle({ segments: [segment({ startMs: 1 })] })
      )
    ).toThrowError(
      expect.objectContaining<Partial<SessionTranscriptPayloadError>>({
        status: 400,
      })
    );
  });

  it('拒绝负时间、倒置区间和可使 DB Int 溢出的时长', () => {
    for (const malicious of [
      segment({ globalStartMs: -1, startMs: -1 }),
      segment({
        globalStartMs: 2_000,
        startMs: 2_000,
        globalEndMs: 1_000,
        endMs: 1_000,
      }),
      segment({
        globalEndMs: SESSION_TRANSCRIPT_LIMITS.maxTimelineMs + 1,
        endMs: SESSION_TRANSCRIPT_LIMITS.maxTimelineMs + 1,
      }),
    ]) {
      expect(() =>
        admitPersistedTranscriptBundle(bundle({ segments: [malicious] }))
      ).toThrowError(
        expect.objectContaining<Partial<SessionTranscriptPayloadError>>({
          status: 400,
        })
      );
    }

    expect(() =>
      admitSessionFinalizePayload({
        durationMs: SESSION_TRANSCRIPT_LIMITS.maxTimelineMs + 1,
      })
    ).toThrowError(
      expect.objectContaining<Partial<SessionTranscriptPayloadError>>({
        status: 400,
      })
    );
  });

  it('按单字段 UTF-8 字节而非 UTF-16 字符数拒绝超限', () => {
    const oversizedUnicode = '你'.repeat(
      Math.floor(SESSION_TRANSCRIPT_LIMITS.maxTextUtf8Bytes / 3) + 1
    );
    expect(() =>
      admitPersistedTranscriptBundle(
        bundle({ segments: [segment({ text: oversizedUnicode })] })
      )
    ).toThrowError(
      expect.objectContaining<Partial<SessionTranscriptPayloadError>>({
        status: 413,
      })
    );
  });

  it('在持久化前拒绝超量 segments 和聚合序列化字节', () => {
    expect(() =>
      admitPersistedTranscriptBundle(
        bundle({
          segments: Array.from(
            { length: SESSION_TRANSCRIPT_LIMITS.maxSegments + 1 },
            (_, index) => segment({ id: `seg-${index}` })
          ),
        })
      )
    ).toThrowError(
      expect.objectContaining<Partial<SessionTranscriptPayloadError>>({
        status: 413,
      })
    );

    const maxField = 'x'.repeat(SESSION_TRANSCRIPT_LIMITS.maxTextUtf8Bytes);
    expect(() =>
      admitPersistedTranscriptBundle(
        bundle({
          segments: Array.from({ length: 128 }, (_, index) =>
            segment({ id: `seg-${index}`, text: maxField })
          ),
          translations: {},
        })
      )
    ).toThrowError(
      expect.objectContaining<Partial<SessionTranscriptPayloadError>>({
        status: 413,
      })
    );
  });

  it('逐项计数拒绝高属性数对象，不先物化 entries 数组', () => {
    const translations: Record<string, string> = {};
    for (
      let index = 0;
      index <= SESSION_TRANSCRIPT_LIMITS.maxTranslations;
      index += 1
    ) {
      translations[`seg-${index}`] = 'x';
    }

    expect(() =>
      admitPersistedTranscriptBundle(bundle({ translations }))
    ).toThrowError(
      expect.objectContaining<Partial<SessionTranscriptPayloadError>>({
        status: 413,
      })
    );
  });

  it('拒绝 segment/摘要嵌套中的未知字段，不把任意对象复制到磁盘', () => {
    expect(() =>
      admitPersistedTranscriptBundle(
        bundle({
          segments: [segment({ attacker: { nested: { value: 'x' } } })],
        })
      )
    ).toThrowError(
      expect.objectContaining<Partial<SessionTranscriptPayloadError>>({
        status: 400,
      })
    );

    expect(() =>
      admitPersistedTranscriptBundle(
        bundle({
          summaries: [
            {
              id: 'summary-1',
              blockIndex: 0,
              timeRange: { startMs: 0, endMs: 1, nested: {} },
              keyPoints: [],
              definitions: {},
              summary: '',
              suggestedQuestions: [],
              frozen: true,
            },
          ],
        })
      )
    ).toThrowError(
      expect.objectContaining<Partial<SessionTranscriptPayloadError>>({
        status: 400,
      })
    );
  });

  it('对无 Content-Length/虚假小 Content-Length 仍按实际流字节关闭失败', async () => {
    const raw = JSON.stringify(bundle());
    const request = new Request('http://localhost/transcript', {
      method: 'POST',
      headers: { 'content-length': '1' },
      body: raw,
    });
    await expect(
      readBoundedSessionJson(request, { maxBytes: raw.length - 1 })
    ).rejects.toMatchObject({ status: 413 });
  });

  it('大量微小 stream chunk 也在固定字节预算内合并', async () => {
    const raw = JSON.stringify(bundle());
    const encoded = new TextEncoder().encode(raw);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const request = new Request('http://localhost/transcript', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    await expect(
      readBoundedSessionJson(request, { maxBytes: encoded.byteLength })
    ).resolves.toEqual(bundle());
  });

  it('超限 Content-Length 在打开 body reader 前拒绝', async () => {
    let bodyRead = false;
    const request = {
      headers: new Headers({ 'content-length': '9' }),
      get body() {
        bodyRead = true;
        return null;
      },
    } as unknown as Request;

    await expect(
      readBoundedSessionJson(request, { maxBytes: 8 })
    ).rejects.toMatchObject({ status: 413 });
    expect(bodyRead).toBe(false);
  });
});
