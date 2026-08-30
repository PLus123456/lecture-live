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
  conversationUpdateManyMock,
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
  attachmentReleaseMock,
  loadSessionTranscriptBundleMock,
  loadSessionReportMock,
  buildLlmRoutingOptionsMock,
  buildChatPromptMock,
  findCompressionBoundaryMock,
  persistChatImageMock,
  estimateRawContextTokensMock,
  sessionFindManyMock,
  prismaQueryRawMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceApiRateLimitMock: vi.fn(),
  conversationFindUniqueMock: vi.fn(),
  conversationMessageCreateMock: vi.fn(),
  conversationUpdateMock: vi.fn(),
  conversationUpdateManyMock: vi.fn(),
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
  attachmentReleaseMock: vi.fn(),
  loadSessionTranscriptBundleMock: vi.fn(),
  loadSessionReportMock: vi.fn(),
  buildLlmRoutingOptionsMock: vi.fn(),
  buildChatPromptMock: vi.fn(),
  findCompressionBoundaryMock: vi.fn(),
  persistChatImageMock: vi.fn(),
  estimateRawContextTokensMock: vi.fn(),
  sessionFindManyMock: vi.fn(),
  prismaQueryRawMock: vi.fn(),
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
      updateMany: conversationUpdateManyMock,
    },
    conversationMessage: {
      create: conversationMessageCreateMock,
    },
    session: { findMany: sessionFindManyMock },
    $queryRaw: prismaQueryRawMock,
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
  computeTranscriptContentSignature: vi.fn(() => 'test-signature'),
  makeRagRetrieverForSession: makeRagRetrieverForSessionMock,
  makeRagRetrieverForRecordings: makeRagRetrieverForRecordingsMock,
}));

vi.mock('@/lib/llm/chatAttachments', () => ({
  ChatAttachmentCapacityError: class ChatAttachmentCapacityError extends Error {
    constructor() {
      super('Attachment processing capacity is busy; retry later');
      this.name = 'ChatAttachmentCapacityError';
    }
  },
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

import { ChatAttachmentCapacityError } from '@/lib/llm/chatAttachments';
import { POST } from '@/app/api/llm/chat/route';
import { ChatContextEOLError } from '@/lib/llm/chatContextBuilder';
import { __resetConversationTurnLocks } from '@/lib/llm/conversationTurnLock';

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
    // 每对话回复锁是模块级进程内状态：测试间清空，避免上一个用例漏放的锁误伤下一个用例。
    __resetConversationTurnLocks();
    verifyAuthMock.mockResolvedValue({
      id: 'user-1',
      email: 'a@example.com',
      role: 'PRO',
    });
    enforceApiRateLimitMock.mockResolvedValue(null);

    resolveAuthorizedLlmSelectionMock.mockResolvedValue({
      user: { role: 'PRO' },
      providerConfig: {
        contextWindow: 200_000,
        displayName: 'mock',
        supportsImage: true,
      },
      providerName: 'mock',
      featureFlags: {
        maxThinkingDepth: 'high',
        allowRealtimeSummary: true,
        allowFinalSummary: true,
      },
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
    sessionFindManyMock.mockImplementation(
      ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.map((id) => ({ id, durationMs: 60_000 }))
        )
    );
    prismaQueryRawMock.mockImplementation((query: { strings?: string[] }) =>
      query.strings?.join('').includes('SiteSetting')
        ? Promise.resolve([{ value: 'complete' }])
        : Promise.resolve([])
    );

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
    loadAttachmentsAsSystemBlocksMock.mockResolvedValue({
      blocks: [],
      release: attachmentReleaseMock,
    });
    loadSessionTranscriptBundleMock.mockResolvedValue({
      segments: [],
      summaries: [],
      translations: {},
    });
    loadSessionReportMock.mockResolvedValue(null);
    persistChatImageMock.mockResolvedValue('/img/x.png');
    conversationMessageCreateMock.mockResolvedValue({ id: 'm-new' });
    conversationUpdateMock.mockResolvedValue({});
    conversationUpdateManyMock.mockReturnValue({}); // 作为 $transaction 数组项，返回值形态无关
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
      expect(makeRagRetrieverForSessionMock).toHaveBeenCalledWith(
        'sess-1',
        'user-1'
      );
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
        'user-1',
        expect.any(Function),
        expect.any(String)
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
      expect(makeRagRetrieverForSessionMock).toHaveBeenCalledWith(
        'sess-long',
        'user-1'
      );
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

      loadAttachmentsAsSystemBlocksMock.mockResolvedValue({
        blocks: [
          {
            attachmentId: 'att-1',
            kind: 'document',
            fileName: 'spec.pdf',
            text: 'SPEC_CONTENT',
          },
        ],
        release: attachmentReleaseMock,
      });
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
          attachmentIds: ['att-1'],
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
        userId: 'user-1',
        attachmentIds: ['att-1'],
        allowImages: true,
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
        userId: 'user-1',
        attachmentIds: undefined,
        allowImages: true,
      });
    });

    it('attachmentIds 与模型图片能力参数透传给 loader', async () => {
      resolveAuthorizedLlmSelectionMock.mockResolvedValueOnce({
        user: { role: 'PRO' },
        providerConfig: {
          contextWindow: 200_000,
          displayName: 'text-only',
          supportsImage: false,
        },
        providerName: 'mock',
        featureFlags: {
          maxThinkingDepth: 'high',
          allowRealtimeSummary: true,
          allowFinalSummary: true,
        },
      });
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
        userId: 'user-1',
        attachmentIds: ['att-1'],
        allowImages: false,
      });
    });

    it('附件进程容量已满 → 立即 429 且带 Retry-After', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-busy',
        userId: 'user-1',
        sessionId: null,
        endedAt: null,
        degradationLevel: 1,
        session: null,
        messages: [],
        sessions: [],
        attachments: [{ id: 'att-1', userId: 'user-1' }],
      });
      loadAttachmentsAsSystemBlocksMock.mockRejectedValueOnce(
        new ChatAttachmentCapacityError()
      );

      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: {
          conversationId: 'conv-busy',
          question: 'q',
          attachmentIds: ['att-1'],
        },
      });
      const res = await POST(req, {} as never);

      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('1');
    });

    it('附件加载后若流开始前失败，会立即释放附件 lease', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-prestream-error',
        userId: 'user-1',
        sessionId: null,
        endedAt: null,
        degradationLevel: 1,
        session: null,
        messages: [],
        sessions: [],
        attachments: [{ id: 'att-1', userId: 'user-1' }],
      });
      estimateRawContextTokensMock.mockImplementationOnce(() => {
        throw new Error('pre-stream context assembly failed');
      });

      const response = await POST(
        createJsonRequest('http://localhost:3000/api/llm/chat', {
          method: 'POST',
          body: {
            conversationId: 'conv-prestream-error',
            question: 'q',
            attachmentIds: ['att-1'],
          },
        }),
        {} as never
      );

      expect(response.status).toBe(500);
      expect(attachmentReleaseMock).toHaveBeenCalledTimes(1);
      expect(callLLMWithHistoryStreamMock).not.toHaveBeenCalled();
    });

    it('Promise.all 的 sibling 先失败时，迟到的附件 lease 仍会被释放', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-late-lease',
        userId: 'user-1',
        sessionId: null,
        endedAt: null,
        degradationLevel: 1,
        session: null,
        messages: [],
        sessions: [
          {
            conversationId: 'conv-late-lease',
            sessionId: 'sess-broken',
            addedAt: new Date(),
            session: {
              id: 'sess-broken',
              userId: 'user-1',
              targetLang: 'zh',
              title: 'Broken',
              recordingPath: null,
              transcriptPath: '/broken.json',
              summaryPath: null,
              reportPath: null,
            },
          },
        ],
        attachments: [{ id: 'att-1', userId: 'user-1' }],
      });
      loadSessionTranscriptBundleMock.mockResolvedValueOnce({
        get segments() {
          throw new Error('broken transcript shape');
        },
        summaries: [],
        translations: {},
      });
      let finishAttachmentLoad!: (loaded: {
        blocks: unknown[];
        release: () => void;
      }) => void;
      loadAttachmentsAsSystemBlocksMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishAttachmentLoad = resolve;
          })
      );

      const response = await POST(
        createJsonRequest('http://localhost:3000/api/llm/chat', {
          method: 'POST',
          body: {
            conversationId: 'conv-late-lease',
            question: 'q',
            attachmentIds: ['att-1'],
          },
        }),
        {} as never
      );
      expect(response.status).toBe(500);
      expect(attachmentReleaseMock).not.toHaveBeenCalled();

      finishAttachmentLoad({ blocks: [], release: attachmentReleaseMock });
      await vi.waitFor(() => {
        expect(attachmentReleaseMock).toHaveBeenCalledTimes(1);
      });
    });

    it('下载完成后仍持有附件 lease，直到慢上游流真正结束', async () => {
      conversationFindUniqueMock.mockImplementation(
        async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          userId: 'user-1',
          sessionId: null,
          endedAt: null,
          degradationLevel: 1,
          session: null,
          messages: [],
          sessions: [],
          attachments: [{ id: 'att-1', userId: 'user-1' }],
        })
      );

      let attachmentLeaseHeld = false;
      let firstReleaseCount = 0;
      loadAttachmentsAsSystemBlocksMock.mockImplementation(async () => {
        if (attachmentLeaseHeld) throw new ChatAttachmentCapacityError();
        attachmentLeaseHeld = true;
        let released = false;
        return {
          blocks: [
            {
              attachmentId: 'att-1',
              kind: 'document',
              fileName: 'held.txt',
              text: 'already downloaded',
            },
          ],
          release: () => {
            if (released) return;
            released = true;
            firstReleaseCount += 1;
            attachmentLeaseHeld = false;
          },
        };
      });

      let finishFirstUpstream!: () => void;
      const firstUpstreamGate = new Promise<void>((resolve) => {
        finishFirstUpstream = resolve;
      });
      let markFirstUpstreamStarted!: () => void;
      const firstUpstreamStarted = new Promise<void>((resolve) => {
        markFirstUpstreamStarted = resolve;
      });
      let upstreamCall = 0;
      callLLMWithHistoryStreamMock.mockImplementation(
        async (
          _sys: string,
          _msgs: unknown,
          _opts: unknown,
          onEvent: (ev: { type: string; delta?: string }) => void
        ) => {
          upstreamCall += 1;
          onEvent({ type: 'text', delta: 'hello' });
          if (upstreamCall === 1) {
            markFirstUpstreamStarted();
            await firstUpstreamGate;
          }
          return {
            text: 'hello',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
      );

      const first = await POST(
        createJsonRequest('http://localhost:3000/api/llm/chat', {
          method: 'POST',
          body: {
            conversationId: 'conv-slow-1',
            question: 'q',
            attachmentIds: ['att-1'],
          },
        }),
        {} as never
      );
      await firstUpstreamStarted;
      expect(firstReleaseCount).toBe(0);

      const whileHeld = await POST(
        createJsonRequest('http://localhost:3000/api/llm/chat', {
          method: 'POST',
          body: {
            conversationId: 'conv-slow-2',
            question: 'q',
            attachmentIds: ['att-1'],
          },
        }),
        {} as never
      );
      expect(whileHeld.status).toBe(429);
      expect(firstReleaseCount).toBe(0);

      finishFirstUpstream();
      await consumeSseEvents(first);
      expect(firstReleaseCount).toBe(1);

      const afterRelease = await POST(
        createJsonRequest('http://localhost:3000/api/llm/chat', {
          method: 'POST',
          body: {
            conversationId: 'conv-slow-3',
            question: 'q',
            attachmentIds: ['att-1'],
          },
        }),
        {} as never
      );
      expect(afterRelease.status).toBe(200);
      await consumeSseEvents(afterRelease);
    });

    it('客户端取消只 abort，上游延迟退出期间仍保留附件 lease', async () => {
      conversationFindUniqueMock.mockImplementation(
        async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          userId: 'user-1',
          sessionId: null,
          endedAt: null,
          degradationLevel: 1,
          session: null,
          messages: [],
          sessions: [],
          attachments: [{ id: 'att-1', userId: 'user-1' }],
        })
      );

      let attachmentLeaseHeld = false;
      let notifyLeaseReleased!: () => void;
      const leaseReleased = new Promise<void>((resolve) => {
        notifyLeaseReleased = resolve;
      });
      loadAttachmentsAsSystemBlocksMock.mockImplementation(async () => {
        if (attachmentLeaseHeld) throw new ChatAttachmentCapacityError();
        attachmentLeaseHeld = true;
        let released = false;
        return {
          blocks: [
            {
              attachmentId: 'att-1',
              kind: 'document',
              fileName: 'held.txt',
              text: 'already downloaded',
            },
          ],
          release: () => {
            if (released) return;
            released = true;
            attachmentLeaseHeld = false;
            notifyLeaseReleased();
          },
        };
      });

      let allowAbortExit!: () => void;
      const abortExitGate = new Promise<void>((resolve) => {
        allowAbortExit = resolve;
      });
      let notifyAbortObserved!: () => void;
      const abortObserved = new Promise<void>((resolve) => {
        notifyAbortObserved = resolve;
      });
      callLLMWithHistoryStreamMock.mockImplementationOnce(
        async (
          _sys: string,
          _msgs: unknown,
          opts: { signal: AbortSignal },
          onEvent: (ev: { type: string; delta?: string }) => void
        ) => {
          onEvent({ type: 'text', delta: 'partial' });
          if (opts.signal.aborted) {
            notifyAbortObserved();
          } else {
            opts.signal.addEventListener('abort', notifyAbortObserved, {
              once: true,
            });
          }
          await abortObserved;
          await abortExitGate;
          throw new Error('aborted after provider cleanup');
        }
      );

      const first = await POST(
        createJsonRequest('http://localhost:3000/api/llm/chat', {
          method: 'POST',
          body: {
            conversationId: 'conv-abort-1',
            question: 'q',
            attachmentIds: ['att-1'],
          },
        }),
        {} as never
      );
      expect(first.status).toBe(200);
      await first.body!.cancel();
      await abortObserved;

      const whileProviderExits = await POST(
        createJsonRequest('http://localhost:3000/api/llm/chat', {
          method: 'POST',
          body: {
            conversationId: 'conv-abort-2',
            question: 'q',
            attachmentIds: ['att-1'],
          },
        }),
        {} as never
      );
      expect(whileProviderExits.status).toBe(429);
      expect(attachmentLeaseHeld).toBe(true);

      allowAbortExit();
      await leaseReleased;
      expect(attachmentLeaseHeld).toBe(false);

      const afterProviderExit = await POST(
        createJsonRequest('http://localhost:3000/api/llm/chat', {
          method: 'POST',
          body: {
            conversationId: 'conv-abort-3',
            question: 'q',
            attachmentIds: ['att-1'],
          },
        }),
        {} as never
      );
      expect(afterProviderExit.status).toBe(200);
      await consumeSseEvents(afterProviderExit);
    });
  });

  describe('common error paths', () => {
    it('首个超长 transcript 段直接413，不查库也不调 provider', async () => {
      const response = await POST(
        createJsonRequest('http://localhost:3000/api/llm/chat', {
          method: 'POST',
          body: {
            conversationId: 'conv-legacy',
            question: 'hello',
            transcript: [{ text: 'x'.repeat(64 * 1024 + 1), startMs: 0 }],
          },
        }),
        {} as never
      );

      expect(response.status).toBe(413);
      expect(conversationFindUniqueMock).not.toHaveBeenCalled();
      expect(callLLMWithHistoryStreamMock).not.toHaveBeenCalled();
      expect(callEmbeddingMock).not.toHaveBeenCalled();
    });

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

  // ── H5：连续失败留下的多条尾部孤儿 user 全部剥离（防旧问题复活）──
  describe('dropTrailingOrphanUser（H5）', () => {
    it('历史尾部有连续两条未配对 user → 全部从发给模型的 history 中剥离', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-orphans',
        userId: 'user-1',
        sessionId: 'sess-1',
        endedAt: null,
        degradationLevel: 1,
        session: { id: 'sess-1', userId: 'user-1', targetLang: 'zh' },
        // A0(assistant) → U1(user) → U2(user)：U1、U2 都是首 token 前失败留下的孤儿
        messages: [
          { role: 'assistant', content: 'A0', transcriptOffsetMs: 0 },
          { role: 'user', content: 'U1', transcriptOffsetMs: 0 },
          { role: 'user', content: 'U2', transcriptOffsetMs: 0 },
        ],
        sessions: [],
        attachments: [],
      });

      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: {
          conversationId: 'conv-orphans',
          question: 'U3',
          transcript: [{ text: 'live', startMs: 0 }],
        },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(200);
      await consumeSseEvents(res);

      // 传给 buildChatContext 的 history 必须只剩 A0，U1/U2 均被剥离（否则旧问题复活）
      const historyArg = buildChatContextMock.mock.calls[0][0].history as Array<{
        role: string;
        content: string;
      }>;
      expect(historyArg).toHaveLength(1);
      expect(historyArg[0]).toMatchObject({ role: 'assistant', content: 'A0' });
      expect(historyArg.some((m) => m.content === 'U1')).toBe(false);
      expect(historyArg.some((m) => m.content === 'U2')).toBe(false);
    });
  });

  // ── H3：degradationLevel 条件更新（只升不降，防 lost update）+ 每对话回复锁 ──
  describe('并发与降级（H3）', () => {
    it('落库用 updateMany + where degradationLevel<effectiveLevel（条件更新，非 Math.max 快照覆盖）', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-deg',
        userId: 'user-1',
        sessionId: 'sess-1',
        endedAt: null,
        degradationLevel: 1,
        session: { id: 'sess-1', userId: 'user-1', targetLang: 'zh' },
        messages: [],
        sessions: [],
        attachments: [],
      });
      // 本轮 effectiveLevel = 3
      buildChatContextMock.mockResolvedValue(
        makeDefaultBuildChatContextResult(3)
      );

      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: {
          conversationId: 'conv-deg',
          question: 'q',
          transcript: [{ text: 'live', startMs: 0 }],
        },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(200);
      await consumeSseEvents(res);

      expect(conversationUpdateManyMock).toHaveBeenCalledWith({
        where: { id: 'conv-deg', degradationLevel: { lt: 3 } },
        data: { degradationLevel: 3 },
      });
    });

    it('同一对话已有进行中回复时，第二个并发请求 fail-fast 返回 409', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-busy',
        userId: 'user-1',
        sessionId: 'sess-1',
        endedAt: null,
        degradationLevel: 1,
        session: { id: 'sess-1', userId: 'user-1', targetLang: 'zh' },
        messages: [],
        sessions: [],
        attachments: [],
      });

      // 让第一轮的流式调用挂起，把锁一直握住，直到我们手动放行。
      let releaseUpstream!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseUpstream = resolve;
      });
      callLLMWithHistoryStreamMock.mockImplementationOnce(
        async (
          _sys: string,
          _msgs: unknown,
          _opts: unknown,
          onEvent: (ev: { type: string; delta?: string }) => void
        ) => {
          onEvent({ type: 'text', delta: 'partial' });
          await gate;
          return { text: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
        }
      );

      const body = {
        conversationId: 'conv-busy',
        question: 'q',
        transcript: [{ text: 'live', startMs: 0 }],
      };
      // 第一轮：拿到 Response（流仍在进行，锁被持有），先不 drain
      const res1 = await POST(
        createJsonRequest('http://localhost:3000/api/llm/chat', {
          method: 'POST',
          body,
        }),
        {} as never
      );
      expect(res1.status).toBe(200);

      // 第二轮并发：同一对话仍在生成 → 409
      const res2 = await POST(
        createJsonRequest('http://localhost:3000/api/llm/chat', {
          method: 'POST',
          body,
        }),
        {} as never
      );
      expect(res2.status).toBe(409);

      // 放行第一轮并 drain，锁释放
      releaseUpstream();
      await consumeSseEvents(res1);
    });
  });

  // ── H4：半截/失败的流不得当正常 assistant 消息落库 ──
  describe('半截流不落库（H4）', () => {
    it('上游发出正文后中途报错 → 不落库 assistant 消息，回 error 帧', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-partial',
        userId: 'user-1',
        sessionId: 'sess-1',
        endedAt: null,
        degradationLevel: 1,
        session: { id: 'sess-1', userId: 'user-1', targetLang: 'zh' },
        messages: [],
        sessions: [],
        attachments: [],
      });

      // 先发一段正文（emittedBytes=true），再抛错模拟 mid-stream error / 截断。
      callLLMWithHistoryStreamMock.mockImplementationOnce(
        async (
          _sys: string,
          _msgs: unknown,
          _opts: unknown,
          onEvent: (ev: { type: string; delta?: string }) => void
        ) => {
          onEvent({ type: 'text', delta: '半截正文' });
          throw new Error('Anthropic streaming error: overloaded');
        }
      );

      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: {
          conversationId: 'conv-partial',
          question: 'q',
          transcript: [{ text: 'live', startMs: 0 }],
        },
      });
      const res = await POST(req, {} as never);
      expect(res.status).toBe(200);
      const { events } = await consumeSseEvents(res);

      // 客户端收到 error 帧
      expect(events.some((e) => e.event === 'error')).toBe(true);
      // 落库 assistant 的 $transaction 绝不能被调用（succeeded=false）
      expect(prismaTransactionMock).not.toHaveBeenCalled();
      // conversationMessage.create 只应为 user 消息调用一次（不含 assistant 兜底插入）
      expect(conversationMessageCreateMock).toHaveBeenCalledTimes(1);
      expect(conversationMessageCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: 'user' }),
        })
      );
    });
  });

  // ── L1：EOL 不该再触发外层降级空转 ──
  describe('EOL 一次到位（L1）', () => {
    it('buildChatContext 抛 ChatContextEOLError → 只调一次 builder，直接回 contextFull', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-eol',
        userId: 'user-1',
        sessionId: 'sess-1',
        endedAt: null,
        degradationLevel: 1,
        session: { id: 'sess-1', userId: 'user-1', targetLang: 'zh' },
        messages: [],
        sessions: [],
        attachments: [],
      });

      // builder 内部已从 currentLevel 试到 MAX 全部塞不下 → EOL。
      // 外层若再抬级重试，每轮都会重新 compressHistory（一次真实 LLM 调用）。
      buildChatContextMock.mockRejectedValue(
        new ChatContextEOLError({
          systemPrompt: 0,
          timeAnchor: 0,
          transcript: 0,
          summary: 0,
          history: 0,
          userInput: 0,
          total: 999_999,
        })
      );

      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: {
          conversationId: 'conv-eol',
          question: 'q',
          transcript: [{ text: 'live', startMs: 0 }],
        },
      });
      const res = await POST(req, {} as never);
      const { events } = await consumeSseEvents(res);

      const errEvent = events.find((e) => e.event === 'error');
      expect(errEvent?.data.contextFull).toBe(true);
      // 关键断言：一次即止，不再 1→7 空转 7 轮
      expect(buildChatContextMock).toHaveBeenCalledTimes(1);
      expect(callLLMWithHistoryStreamMock).not.toHaveBeenCalled();
    });

    it('provider 侧超长报错（非 EOL）仍逐级降级重试', async () => {
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-degrade',
        userId: 'user-1',
        sessionId: 'sess-1',
        endedAt: null,
        degradationLevel: 1,
        session: { id: 'sess-1', userId: 'user-1', targetLang: 'zh' },
        messages: [],
        sessions: [],
        attachments: [],
      });

      // 第一轮 provider 报 context_length（我们的预估偏乐观）→ 降一级后成功。
      callLLMWithHistoryStreamMock.mockImplementationOnce(async () => {
        throw new Error('This model maximum context length is 200000 tokens');
      });

      const req = createJsonRequest('http://localhost:3000/api/llm/chat', {
        method: 'POST',
        body: {
          conversationId: 'conv-degrade',
          question: 'q',
          transcript: [{ text: 'live', startMs: 0 }],
        },
      });
      const res = await POST(req, {} as never);
      await consumeSseEvents(res);

      expect(buildChatContextMock).toHaveBeenCalledTimes(2);
      expect(buildChatContextMock.mock.calls[1][0]).toMatchObject({ minLevel: 2 });
    });
  });
  /**
   * M16：chat 主链路精心做了 resolveAuthorizedLlmSelection → buildLlmRoutingOptions
   * （受限用户 allowedModels、组绑定 chatModelId 生效），主流式调用也确实展开了
   * routingOptions —— 但传给 buildChatContext 的**历史压缩回调**曾硬编码
   * `{ purpose: 'CHAT' }`：受限组用户的对话原文被发往全局默认 CHAT 模型，
   * 组绑定模型被绕过，成本也记错账。
   */
  describe('M16：历史压缩必须走用户已授权的模型路由', () => {
    it('压缩回调透传 routingOptions，而不是硬编码 purpose:CHAT', async () => {
      buildLlmRoutingOptionsMock.mockReturnValue({ modelId: 'model-allowed-only' });
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
          transcript: [{ text: 'live segment', startMs: 0 }],
        },
      });
      const res = await POST(req, {} as never);
      await consumeSseEvents(res);

      // buildChatContext 拿到的压缩回调就是降级链 L4+ 真正会调用的那个
      const builderArg = buildChatContextMock.mock.calls[0][0] as {
        callLLM: (s: string, u: string) => Promise<string>;
      };
      await builderArg.callLLM('COMPRESS_SYS', 'COMPRESS_USER');

      expect(callLLMMock).toHaveBeenCalledWith('COMPRESS_SYS', 'COMPRESS_USER', {
        modelId: 'model-allowed-only',
      });
      expect(callLLMMock).not.toHaveBeenCalledWith(
        'COMPRESS_SYS',
        'COMPRESS_USER',
        { purpose: 'CHAT' }
      );
    });

    it('global 路径同样透传（两条 chat 路径口径一致）', async () => {
      buildLlmRoutingOptionsMock.mockReturnValue({
        providerOverride: 'group-bound-provider',
      });
      conversationFindUniqueMock.mockResolvedValue({
        id: 'conv-global',
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
        body: { conversationId: 'conv-global', question: 'hello' },
      });
      const res = await POST(req, {} as never);
      await consumeSseEvents(res);

      const builderArg = buildChatContextMock.mock.calls[0][0] as {
        callLLM: (s: string, u: string) => Promise<string>;
      };
      await builderArg.callLLM('S', 'U');
      expect(callLLMMock).toHaveBeenCalledWith('S', 'U', {
        providerOverride: 'group-bound-provider',
      });
    });
  });
});
