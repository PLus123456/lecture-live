import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../tests/utils/http';

/**
 * 这套测试关注 /api/llm/chat 的"路由 + 模式判定"层：
 *   1. legacy（conversation.session 非空）→ 不影响 ChatTab 的旧路径
 *   2. global（conversation.session 为空）→ 走多录音 + 附件路径
 *   3. ownership 校验：统一看 Conversation.userId（userId 为 NULL 的无主孤儿 / 他人对话 → 404）
 *
 * 流式部分（SSE）极难干净 mock，所以这里靠 mock 让 callLLMWithHistoryStream 立即结束，
 * 然后通过 `wasInvokedAsLegacy` / `wasInvokedAsGlobal` 两个间接信号判定是否走对路径：
 *   - legacy 路径会调 makeRagRetrieverForSession（单录音 RAG）
 *   - global 路径会调 makeRagRetrieverForRecordings（多录音 RAG）+ loadAttachmentsAsSystemBlocks
 *   - global 路径在 transcript 大时会 forceMinLevel=6（通过 buildChatContext 入参断言）
 */

const {
  verifyAuthMock,
  enforceApiRateLimitMock,
  conversationFindUniqueMock,
  conversationMessageCreateMock,
  conversationUpdateMock,
  prismaTransactionMock,
  resolveAuthorizedLlmSelectionMock,
  resolveEffectiveThinkingDepthMock,
  getProviderForPurposeMock,
  computeContextBudgetMock,
  buildChatContextMock,
  callLLMWithHistoryStreamMock,
  callLLMMock,
  callEmbeddingMock,
  makeRagRetrieverForSessionMock,
  makeRagRetrieverForRecordingsMock,
  loadAttachmentsAsSystemBlocksMock,
  loadSessionTranscriptBundleMock,
  loadSessionReportMock,
  buildLlmRoutingOptionsMock,
  buildChatPromptMock,
  findCompressionBoundaryMock,
  persistChatImageMock,
  estimateRawContextTokensMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceApiRateLimitMock: vi.fn(),
  conversationFindUniqueMock: vi.fn(),
  conversationMessageCreateMock: vi.fn(),
  conversationUpdateMock: vi.fn(),
  prismaTransactionMock: vi.fn(),
  resolveAuthorizedLlmSelectionMock: vi.fn(),
  resolveEffectiveThinkingDepthMock: vi.fn(),
  getProviderForPurposeMock: vi.fn(),
  computeContextBudgetMock: vi.fn(),
  buildChatContextMock: vi.fn(),
  callLLMWithHistoryStreamMock: vi.fn(),
  callLLMMock: vi.fn(),
  callEmbeddingMock: vi.fn(),
  makeRagRetrieverForSessionMock: vi.fn(),
  makeRagRetrieverForRecordingsMock: vi.fn(),
  loadAttachmentsAsSystemBlocksMock: vi.fn(),
  loadSessionTranscriptBundleMock: vi.fn(),
  loadSessionReportMock: vi.fn(),
  buildLlmRoutingOptionsMock: vi.fn(),
  buildChatPromptMock: vi.fn(),
  findCompressionBoundaryMock: vi.fn(),
  persistChatImageMock: vi.fn(),
  estimateRawContextTokensMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceApiRateLimit: enforceApiRateLimitMock }));
vi.mock('@/lib/requestLogger', () => ({
  withRequestLogging: (
    _routeName: string,
    handler: (...args: unknown[]) => unknown
  ) => handler,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    conversation: {
      findUnique: conversationFindUniqueMock,
      update: conversationUpdateMock,
    },
    conversationMessage: {
      create: conversationMessageCreateMock,
    },
    $transaction: prismaTransactionMock,
  },
}));

vi.mock('@/lib/llm/access', () => ({
  LLMAccessError: class LLMAccessError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'LLMAccessError';
    }
  },
  resolveAuthorizedLlmSelection: resolveAuthorizedLlmSelectionMock,
  resolveEffectiveThinkingDepth: resolveEffectiveThinkingDepthMock,
}));

vi.mock('@/lib/llm/gateway', async () => {
  const actual = await vi.importActual<typeof import('@/lib/llm/gateway')>(
    '@/lib/llm/gateway'
  );
  return {
    ...actual,
    callLLM: callLLMMock,
    callEmbedding: callEmbeddingMock,
    callLLMWithHistoryStream: callLLMWithHistoryStreamMock,
    getProviderForPurpose: getProviderForPurposeMock,
  };
});

vi.mock('@/lib/llm/tokenBudget', () => ({
  computeContextBudget: computeContextBudgetMock,
}));

vi.mock('@/lib/llm/chatContextBuilder', async () => {
  const actual = await vi.importActual<typeof import('@/lib/llm/chatContextBuilder')>(
    '@/lib/llm/chatContextBuilder'
  );
  return {
    ...actual,
    buildChatContext: buildChatContextMock,
    estimateRawContextTokens: estimateRawContextTokensMock,
  };
});

vi.mock('@/lib/llm/embedding/transcriptRag', () => ({
  makeRagRetrieverForSession: makeRagRetrieverForSessionMock,
  makeRagRetrieverForRecordings: makeRagRetrieverForRecordingsMock,
}));

vi.mock('@/lib/llm/chatAttachments', () => ({
  loadAttachmentsAsSystemBlocks: loadAttachmentsAsSystemBlocksMock,
  // 实现保持简单 — 这些纯函数在隔离单测里覆盖了
  renderReportAsText: (data: { report?: { topic?: string } } | null) =>
    data?.report?.topic ?? '',
  concatRecordingReports: (
    arr: ReadonlyArray<{ recordingTitle: string; reportText: string }>
  ) =>
    arr
      .filter((r) => r.reportText)
      .map((r) => `[Recording: ${r.recordingTitle}]\n${r.reportText}`)
      .join('\n\n'),
  buildAttachmentsSystemMessage: (
    blocks: ReadonlyArray<{
      kind: string;
      fileName: string;
      text?: string;
    }>
  ) =>
    blocks
      .filter((b) => (b.kind === 'document' || b.kind === 'text') && b.text)
      .map((b) => `[附件: ${b.fileName}]\n${b.text!}`)
      .join('\n\n'),
  extractAttachmentImages: (
    blocks: ReadonlyArray<{
      kind: string;
      imageData?: string;
      imageMediaType?: string;
    }>
  ) =>
    blocks
      .filter((b) => b.kind === 'image' && b.imageData && b.imageMediaType)
      .map((b) => ({ mediaType: b.imageMediaType!, data: b.imageData! })),
}));

vi.mock('@/lib/sessionPersistence', () => ({
  loadSessionTranscriptBundle: loadSessionTranscriptBundleMock,
  loadSessionReport: loadSessionReportMock,
}));

vi.mock('@/lib/llm/llmRoutingOptions', () => ({
  buildLlmRoutingOptions: buildLlmRoutingOptionsMock,
}));

vi.mock('@/lib/llm/prompts', () => ({
  buildChatPrompt: buildChatPromptMock,
}));

vi.mock('@/lib/llm/chatCompression', () => ({
  findCompressionBoundary: findCompressionBoundaryMock,
}));

vi.mock('@/lib/llm/chatImageStorage', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/llm/chatImageStorage')
  >('@/lib/llm/chatImageStorage');
  return {
    ...actual,
    persistChatImage: persistChatImageMock,
  };
});

import { POST } from '@/app/api/llm/chat/route';

interface DoneEvent {
  level: number;
  budget: number;
}

async function consumeSseEvents(response: Response): Promise<{
  events: Array<{ event: string; data: Record<string, unknown> }>;
  done?: DoneEvent;
}> {
  const text = await response.text();
  const frames = text.split('\n\n').filter(Boolean);
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let done: DoneEvent | undefined;
  for (const frame of frames) {
    const lines = frame.split('\n');
    let event = '';
    let dataLine = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLine = line.slice(6);
    }
    if (!event) continue;
    const parsed = dataLine ? (JSON.parse(dataLine) as Record<string, unknown>) : {};
    events.push({ event, data: parsed });
    if (event === 'done') {
      done = parsed as unknown as DoneEvent;
    }
  }
  return { events, done };
}

function makeDefaultBuildChatContextResult(level = 1) {
  return {
    systemPrompt: 'SYS',
    messages: [{ role: 'user' as const, content: 'q' }],
    level,
    breakdown: {
      systemPrompt: 0,
      timeAnchor: 0,
      transcript: 0,
      summary: 0,
      history: 0,
      userInput: 0,
      total: 100,
    },
    reportText: undefined,
  };
}

describe('POST /api/llm/chat (mode routing)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({
      id: 'user-1',
      email: 'a@example.com',
      role: 'PRO',
    });
    enforceApiRateLimitMock.mockResolvedValue(null);

    resolveAuthorizedLlmSelectionMock.mockResolvedValue({
      user: { role: 'PRO' },
      providerConfig: { contextWindow: 200_000, displayName: 'mock' },
      providerName: 'mock',
    });
    resolveEffectiveThinkingDepthMock.mockReturnValue('medium');
    getProviderForPurposeMock.mockResolvedValue({ contextWindow: 200_000 });
    computeContextBudgetMock.mockReturnValue({
      inputBudget: 100_000,
      threshold: 80_000,
    });

    buildChatPromptMock.mockImplementation(
      (t: string, s: string) => `<T>${t}</T><S>${s}</S>`
    );
    findCompressionBoundaryMock.mockReturnValue({ splitIndex: -1, summary: null });

    buildChatContextMock.mockResolvedValue(makeDefaultBuildChatContextResult());
    estimateRawContextTokensMock.mockReturnValue(100); // 远小于 budget*0.8

    // 立即给出一个 text + 立即结束的 streaming 模拟
    callLLMWithHistoryStreamMock.mockImplementation(
      async (
        _sys: string,
        _msgs: unknown,
        _opts: unknown,
        onEvent: (ev: { type: string; delta?: string }) => void
      ) => {
        onEvent({ type: 'text', delta: 'hello' });
        return {
          text: 'hello',
          usage: { inputTokens: 100, outputTokens: 5 },
        };
      }
    );

    callLLMMock.mockResolvedValue('');
    callEmbeddingMock.mockResolvedValue([[0.1]]);
    buildLlmRoutingOptionsMock.mockReturnValue({});
    makeRagRetrieverForSessionMock.mockReturnValue(async () => '');
    makeRagRetrieverForRecordingsMock.mockReturnValue(async () => '');
    loadAttachmentsAsSystemBlocksMock.mockResolvedValue([]);
    loadSessionTranscriptBundleMock.mockResolvedValue({
      segments: [],
      summaries: [],
      translations: {},
    });
    loadSessionReportMock.mockResolvedValue(null);
    persistChatImageMock.mockResolvedValue('/img/x.png');
    conversationMessageCreateMock.mockResolvedValue({ id: 'm-new' });
    conversationUpdateMock.mockResolvedValue({});
    prismaTransactionMock.mockResolvedValue([{ id: 'm-new' }, {}]);
  });

  describe('legacy mode (conversation.session 非空)', () => {
    it('ChatTab 实时请求（带 live transcript）走 makeRagRetrieverForSession，且不走全局路径的 helpers', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-legacy',
        userId: 'user-1',
        sessionId: 'sess-1',
        endedAt: null,
        degradationLevel: 1,
        session: { id: 'sess-1', userId: 'user-1', targetLang: 'zh' },
        messages: [],
        sessions: [],
        attachments: [],
      });

      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: {
          conversationId: 'conv-legacy',
          question: 'hello',
          // ChatTab 的实时路径特征：请求自带 live transcript
          transcript: [{ text: 'live segment', startMs: 0 }],
        },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(200);

      const { done } = await consumeSseEvents(res);
      expect(done?.level).toBe(1);

      // 关键断言：legacy 实时路径必须用 single-session retriever
      expect(makeRagRetrieverForSessionMock).toHaveBeenCalledWith('sess-1');
      // 不能走多录音 retriever
      expect(makeRagRetrieverForRecordingsMock).not.toHaveBeenCalled();
      // 不能调附件 loader（legacy 路径不读附件）
      expect(loadAttachmentsAsSystemBlocksMock).not.toHaveBeenCalled();
      // legacy 现在也做长录音决策（与 global 一致）：会调 estimateRawContextTokens；
      // 小 transcript（默认 mock 返回 100 « budget*0.8）不强制 L6。
      expect(estimateRawContextTokensMock).toHaveBeenCalled();
      const builderArg = buildChatContextMock.mock.calls[0][0];
      expect(builderArg.forceMinLevel).toBeUndefined();
    });

    it('全局对话区打开（无 live transcript/偏移/摘要）→ 走 global 路径，来源录音自动并入 ownedSessions', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-legacy',
        userId: 'user-1',
        sessionId: 'sess-1',
        endedAt: null,
        degradationLevel: 1,
        session: {
          id: 'sess-1',
          userId: 'user-1',
          targetLang: 'zh',
          title: '录音一',
          recordingPath: null,
          transcriptPath: '/t/sess-1.json',
          summaryPath: null,
          reportPath: null,
        },
        messages: [],
        sessions: [],
        attachments: [],
      });
      loadSessionTranscriptBundleMock.mockResolvedValue({
        segments: [{ text: 'stored segment', startMs: 0 }],
        summaries: [],
        translations: {},
      });

      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: {
          conversationId: 'conv-legacy',
          question: 'hello',
          // GlobalChat 的请求特征：无任何 live 上下文
          transcript: [],
          summaryContext: '',
          totalTranscriptMs: 0,
        },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(200);
      await consumeSseEvents(res);

      // 来源录音的文件态 transcript 被加载（"自动挂载"）
      expect(loadSessionTranscriptBundleMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sess-1' })
      );
      // 走多录音 retriever（recordingIds = ['sess-1']），不走单录音 retriever
      expect(makeRagRetrieverForRecordingsMock).toHaveBeenCalledWith(
        ['sess-1'],
        expect.any(Function),
        expect.any(Number)
      );
      expect(makeRagRetrieverForSessionMock).not.toHaveBeenCalled();
    });

    it('长 transcript（超 80% budget）→ legacy 也 forceMinLevel=6（省反应式重试）', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-legacy-long',
        userId: 'user-1',
        sessionId: 'sess-long',
        endedAt: null,
        degradationLevel: 1,
        session: { userId: 'user-1', targetLang: 'zh' },
        messages: [],
        sessions: [],
        attachments: [],
      });
      // 估算超 budget*0.8（80_000）→ 强制 L6
      estimateRawContextTokensMock.mockReturnValue(90_000);

      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: {
          conversationId: 'conv-legacy-long',
          question: 'hello',
          transcript: [{ text: 'a very long transcript', startMs: 0 }],
        },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(200);
      await consumeSseEvents(res);

      // legacy 仍走单录音 retriever
      expect(makeRagRetrieverForSessionMock).toHaveBeenCalledWith('sess-long');
      // buildChatContext 收到 forceMinLevel=6
      const builderArg = buildChatContextMock.mock.calls[0][0];
      expect(builderArg.forceMinLevel).toBe(6);
    });

    it('当 conversation.userId !== user → 404', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-x',
        userId: 'OTHER-USER',
        sessionId: 'sess-x',
        endedAt: null,
        degradationLevel: 1,
        session: { userId: 'OTHER-USER', targetLang: 'zh' },
        messages: [],
        sessions: [],
        attachments: [],
      });

      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: { conversationId: 'conv-x', question: 'q' },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(404);
    });
  });

  describe('global mode (conversation.session 为空)', () => {
    it('多录音 + ownership 通过 → 走 makeRagRetrieverForRecordings + 注入附件', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-global',
        userId: 'user-1',
        sessionId: null,
        endedAt: null,
        degradationLevel: 1,
        session: null,
        messages: [],
        sessions: [
          {
            conversationId: 'conv-global',
            sessionId: 'sess-1',
            addedAt: new Date(),
            session: {
              id: 'sess-1',
              userId: 'user-1',
              targetLang: 'en',
              title: 'Lecture 1',
              recordingPath: null,
              transcriptPath: '/u/transcripts/sess-1.json',
              summaryPath: null,
              reportPath: null,
            },
          },
          {
            conversationId: 'conv-global',
            sessionId: 'sess-2',
            addedAt: new Date(),
            session: {
              id: 'sess-2',
              userId: 'user-1',
              targetLang: 'en',
              title: 'Lecture 2',
              recordingPath: null,
              transcriptPath: null,
              summaryPath: null,
              reportPath: null,
            },
          },
        ],
        attachments: [{ id: 'att-1', userId: 'user-1' }],
      });

      loadAttachmentsAsSystemBlocksMock.mockResolvedValue([
        {
          attachmentId: 'att-1',
          kind: 'document',
          fileName: 'spec.pdf',
          text: 'SPEC_CONTENT',
        },
      ]);
      loadSessionTranscriptBundleMock.mockResolvedValue({
        segments: [
          { text: 'segment 1', startMs: 0 },
          { text: 'segment 2', startMs: 1000 },
        ],
        summaries: [],
        translations: {},
      });

      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: {
          conversationId: 'conv-global',
          question: 'hello',
        },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(200);

      const { done } = await consumeSseEvents(res);
      expect(done).toBeDefined();

      // global 必须走 multi-recording retriever（两个录音 id）
      expect(makeRagRetrieverForRecordingsMock).toHaveBeenCalledTimes(1);
      const ridsArg = makeRagRetrieverForRecordingsMock.mock.calls[0][0];
      expect(ridsArg).toEqual(['sess-1', 'sess-2']);

      // 附件 loader 被调
      expect(loadAttachmentsAsSystemBlocksMock).toHaveBeenCalledWith({
        conversationId: 'conv-global',
        attachmentIds: undefined,
      });

      // 不能走 single-session retriever
      expect(makeRagRetrieverForSessionMock).not.toHaveBeenCalled();

      // 长录音决策被调用（小 transcript 不强制 L6）
      expect(estimateRawContextTokensMock).toHaveBeenCalled();
      const builderArg = buildChatContextMock.mock.calls[0][0];
      expect(builderArg.forceMinLevel).toBeUndefined();

      // attachments system message 应被注入 systemPrompt
      const finalSystemPrompt = callLLMWithHistoryStreamMock.mock.calls[0][0];
      expect(finalSystemPrompt).toContain('附件: spec.pdf');
      expect(finalSystemPrompt).toContain('SPEC_CONTENT');
    });

    it('当 estimateRawContextTokens 超 80% budget → forceMinLevel=6 + 拼接 reportText', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-long',
        userId: 'user-1',
        sessionId: null,
        endedAt: null,
        degradationLevel: 1,
        session: null,
        messages: [],
        sessions: [
          {
            conversationId: 'conv-long',
            sessionId: 'sess-1',
            addedAt: new Date(),
            session: {
              id: 'sess-1',
              userId: 'user-1',
              targetLang: 'zh',
              title: 'Big Lecture',
              recordingPath: null,
              transcriptPath: '/u/transcripts/sess-1.json',
              summaryPath: null,
              reportPath: '/u/reports/sess-1.json',
            },
          },
        ],
        attachments: [],
      });

      loadSessionTranscriptBundleMock.mockResolvedValue({
        segments: [{ text: 'long content', startMs: 0 }],
        summaries: [],
        translations: {},
      });
      loadSessionReportMock.mockResolvedValue({
        significance: { score: 1, reason: '', isWorthSummarizing: true },
        report: { topic: 'BIG_LECTURE_TOPIC' },
        generatedAt: '',
      });

      // 模拟"transcript 很大" — 90,000 > 100,000 * 0.8 = 80,000
      estimateRawContextTokensMock.mockReturnValue(90_000);

      buildChatContextMock.mockResolvedValue({
        ...makeDefaultBuildChatContextResult(6),
        reportText: 'truncated-report',
      });

      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: { conversationId: 'conv-long', question: 'q' },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(200);

      const { done } = await consumeSseEvents(res);
      expect(done?.level).toBe(6);

      // buildChatContext 收到 forceMinLevel=6 + 非空 reportText
      const builderArg = buildChatContextMock.mock.calls[0][0];
      expect(builderArg.forceMinLevel).toBe(6);
      expect(builderArg.reportText).toContain('BIG_LECTURE_TOPIC');
      expect(builderArg.reportText).toContain('[Recording: Big Lecture]');

      // reportText 必须被拼到发给 gateway 的 systemPrompt 里
      const finalSystemPrompt = callLLMWithHistoryStreamMock.mock.calls[0][0];
      expect(finalSystemPrompt).toContain('Recording reports');
      expect(finalSystemPrompt).toContain('truncated-report');
    });

    it('归属他人（conversation.userId 不命中）→ 404', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-foreign',
        userId: 'OTHER-USER',
        sessionId: null,
        endedAt: null,
        degradationLevel: 1,
        session: null,
        messages: [],
        sessions: [
          {
            conversationId: 'conv-foreign',
            sessionId: 'sess-x',
            addedAt: new Date(),
            session: {
              id: 'sess-x',
              userId: 'OTHER-USER',
              targetLang: 'zh',
              title: 'Foreign',
              recordingPath: null,
              transcriptPath: null,
              summaryPath: null,
              reportPath: null,
            },
          },
        ],
        attachments: [{ id: 'att-y', userId: 'OTHER-USER' }],
      });

      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: { conversationId: 'conv-foreign', question: 'q' },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(404);
    });

    it('空 conversation（本人拥有，无 session 无 attachment）→ 允许走全局空 chat', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-empty',
        userId: 'user-1',
        sessionId: null,
        endedAt: null,
        degradationLevel: 1,
        session: null,
        messages: [],
        sessions: [],
        attachments: [],
      });

      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: { conversationId: 'conv-empty', question: 'hi' },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(200);

      // recordingIds 为空 → 多录音 retriever 不该被调
      expect(makeRagRetrieverForRecordingsMock).not.toHaveBeenCalled();
      // attachments 调一次但结果空
      expect(loadAttachmentsAsSystemBlocksMock).toHaveBeenCalledWith({
        conversationId: 'conv-empty',
        attachmentIds: undefined,
      });
    });

    it('attachmentIds 参数透传给 loader', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-with-att',
        userId: 'user-1',
        sessionId: null,
        endedAt: null,
        degradationLevel: 1,
        session: null,
        messages: [],
        sessions: [],
        attachments: [{ id: 'att-1', userId: 'user-1' }],
      });

      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: {
          conversationId: 'conv-with-att',
          question: 'q',
          attachmentIds: ['att-1'],
        },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(200);
      await consumeSseEvents(res);

      expect(loadAttachmentsAsSystemBlocksMock).toHaveBeenCalledWith({
        conversationId: 'conv-with-att',
        attachmentIds: ['att-1'],
      });
    });
  });

  describe('common error paths', () => {
    it('未登录 → 401', async () => {
      verifyAuthMock.mockResolvedValue(null);
      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: { conversationId: 'c', question: 'q' },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(401);
    });

    it('conversation 不存在 → 404', async () => {
      conversationFindUniqueMock.mockResolvedValue(null);
      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: { conversationId: 'missing', question: 'q' },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(404);
    });

    it('conversation 已 endedAt → 409', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv',
        userId: 'user-1',
        sessionId: 'sess',
        endedAt: new Date(),
        degradationLevel: 1,
        session: { userId: 'user-1', targetLang: 'zh' },
        messages: [],
        sessions: [],
        attachments: [],
      });
      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: { conversationId: 'conv', question: 'q' },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(409);
    });

    it('attachmentIds 非数组 → 400', async () => {
      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: {
          conversationId: 'c',
          question: 'q',
          attachmentIds: 'not-an-array',
        },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(400);
    });
  });
});
