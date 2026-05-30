'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  useChatStore,
  preferenceToFields,
  EMPTY_CONVERSATION_RUNTIME,
  type ConversationMeta,
} from '@/stores/chatStore';
import { useAuthStore } from '@/stores/authStore';
import type { ChatMessage, ChatModelsResponse, ThinkingDepth } from '@/types/llm';
import { estimateTokens } from '@/lib/llm/tokenizer';
import { findCompressionBoundary } from '@/lib/llm/chatCompression';

interface TranscriptSegmentInput {
  text: string;
  startMs: number;
}

/**
 * 把 chat 历史 + 当前输入估算成 token 用量。仅用于小圈 UI 展示，
 * 真实预算判定在服务端 chatContextBuilder 里。
 *
 * budget 由调用方传入（来自所选模型的 contextWindow，经 computeContextBudget
 * 折算 inputBudget）—— 与服务端口径一致，不再使用任何硬编码常量。
 */
function estimateChatUsage(input: {
  systemPrompt: string;
  transcript: string;
  summary: string;
  history: ReadonlyArray<{ content: string }>;
  userInput: string;
  budget: number;
  level: number;
}) {
  const systemPrompt = estimateTokens(input.systemPrompt);
  const transcript = estimateTokens(input.transcript);
  const summary = estimateTokens(input.summary);
  const history = input.history.reduce(
    (acc, m) => acc + estimateTokens(m.content),
    0
  );
  const userInput = estimateTokens(input.userInput);
  return {
    used: systemPrompt + transcript + summary + history + userInput,
    budget: input.budget,
    level: input.level,
    breakdown: { systemPrompt, transcript, summary, history, userInput },
  };
}

/**
 * 从所选模型的 contextWindow 推导前端展示用的 inputBudget。
 * 没有可用模型信息时返回 0（UI 会按 0 处理，不再编造数字）。
 *
 * 口径与服务端 tokenBudget.computeContextBudget 一致：
 *   inputBudget = (contextWindow - outputMaxTokens) × 0.8
 * tokenBudget.ts 标了 server-only，故此处内联同样的算式（仅用于 UI 展示）。
 */
function deriveBudgetFromModel(
  models: ReadonlyArray<{ name: string; contextWindow?: number }>,
  selectedModel: string
): number {
  const model = models.find((m) => m.name === selectedModel);
  const contextWindow = model?.contextWindow ?? 0;
  if (contextWindow <= 0) return 0;
  const outputMaxTokens = Math.max(
    1,
    Math.min(4096, Math.floor(contextWindow * 0.25), 8192)
  );
  return Math.floor(Math.max(0, contextWindow - outputMaxTokens) * 0.8);
}

export function useChat(sessionId: string | null) {
  const {
    selectedModel,
    selectedThinkingPreference,
    availableModels,
    modelsLoaded,
    activeConversationId,
    conversations,
    byConversation,
    setLoading,
    setSelectedModel,
    setSelectedThinkingPreference,
    setAvailableModels,
    setActiveConversation,
    setConversations,
    setMessages,
    addMessage,
    updateMessage,
    setTokenUsage,
    setContextFull,
    resetSession,
  } = useChatStore();

  // 当前活跃对话的运行时切片 —— messages/isLoading/tokenUsage/contextFull/archived
  // 全从这里派生（按 conversationId 隔离，不再读全局单例字段）。
  const activeRuntime =
    (activeConversationId && byConversation[activeConversationId]) ||
    EMPTY_CONVERSATION_RUNTIME;
  const { messages, archivedMessages, isLoading, tokenUsage, contextFull } =
    activeRuntime;

  const token = useAuthStore((s) => s.token);
  const lastLoadedSessionRef = useRef<string | null>(null);
  const sendAbortRef = useRef<AbortController | null>(null);

  /* ──────────────────────────────────────────────────────────────
     拉取模型列表（一次性）
     ────────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!token || modelsLoaded) return;
    fetch('/api/llm/models', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch models');
        return res.json() as Promise<ChatModelsResponse>;
      })
      .then((data) => setAvailableModels(data.models, data.defaultModel))
      .catch((err) => {
        // 静默失败：UI 会显示默认模型
        console.error('Failed to load chat models:', err);
      });
  }, [token, modelsLoaded, setAvailableModels]);

  /* ──────────────────────────────────────────────────────────────
     sessionId 变化时拉取 conversations，确保有活跃 conv
     ────────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!token || !sessionId) return;
    if (lastLoadedSessionRef.current === sessionId) return;
    lastLoadedSessionRef.current = sessionId;

    resetSession();

    const headers = { Authorization: `Bearer ${token}` };
    (async () => {
      try {
        const listRes = await fetch(
          `/api/conversations?sessionId=${encodeURIComponent(sessionId)}`,
          { headers }
        );
        if (!listRes.ok) throw new Error(`list ${listRes.status}`);
        const listData = (await listRes.json()) as { conversations: ConversationMeta[] };
        let list = listData.conversations;
        let active = list.find((c) => c.endedAt === null);

        // 没有活跃 conversation → 自动创建一个
        if (!active) {
          const createRes = await fetch('/api/conversations', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          });
          if (!createRes.ok) throw new Error(`create ${createRes.status}`);
          const created = (await createRes.json()) as { conversation: ConversationMeta };
          active = created.conversation;
          list = [...list, active];
        }

        setConversations(list);
        setActiveConversation(active.id);

        // 拉取活跃 conversation 的消息
        await loadConversationMessages(active.id);
      } catch (err) {
        console.error('Failed to init conversations:', err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, sessionId]);

  /* 切换 session 或卸载时，中止仍在进行的发送流（防止旧流写入共享 chat store）。 */
  useEffect(() => {
    return () => {
      sendAbortRef.current?.abort();
    };
  }, [sessionId]);

  /* ──────────────────────────────────────────────────────────────
     加载某个 conversation 的消息（含 system 摘要切割）
     ────────────────────────────────────────────────────────────── */
  const loadConversationMessages = useCallback(
    async (conversationId: string) => {
      if (!token) return;
      try {
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) throw new Error(`messages ${res.status}`);
        const data = (await res.json()) as {
          messages: Array<{
            id: string;
            role: string;
            content: string;
            transcriptOffsetMs: number | null;
            degradationLevel: number | null;
            inputTokens: number | null;
            outputTokens: number | null;
            createdAt: string;
          }>;
        };

        // 找最近一条压缩边界 → 分割成 archivedMessages + messages
        const compressionBoundary = findCompressionBoundary(data.messages);

        const toChatMessage = (raw: (typeof data.messages)[number]): ChatMessage => ({
          id: raw.id,
          role: raw.role === 'assistant' ? 'assistant' : 'user',
          content: raw.content,
          timestamp: new Date(raw.createdAt).getTime(),
        });

        const archived = data.messages
          .slice(0, compressionBoundary.splitIndex + 1)
          .filter((m) => m.role !== 'system')
          .map(toChatMessage);
        const visible = data.messages
          .slice(compressionBoundary.splitIndex + 1)
          .filter((m) => m.role !== 'system')
          .map(toChatMessage);

        setMessages(conversationId, visible, archived);

        // 用最后一条 assistant 消息的 inputTokens 作为已用量种子，
        // budget 由所选模型的 contextWindow 推导 —— 进入对话就显示真实数字。
        const lastAssistant = [...data.messages]
          .reverse()
          .find((m) => m.role === 'assistant' && m.inputTokens != null);
        const budget = deriveBudgetFromModel(
          useChatStore.getState().availableModels,
          useChatStore.getState().selectedModel
        );
        if (lastAssistant?.inputTokens != null || budget > 0) {
          const used = lastAssistant?.inputTokens ?? 0;
          setTokenUsage(conversationId, {
            used,
            budget,
            level: lastAssistant?.degradationLevel ?? 1,
            breakdown: {
              systemPrompt: 0,
              transcript: 0,
              summary: 0,
              history: used,
              userInput: 0,
            },
          });
        }
      } catch (err) {
        console.error('Failed to load conversation messages:', err);
      }
    },
    [token, setMessages, setTokenUsage]
  );

  /* ──────────────────────────────────────────────────────────────
     发送消息（SSE 流式消费）
     ────────────────────────────────────────────────────────────── */
  const sendMessage = useCallback(
    async (
      question: string,
      transcriptSegments: ReadonlyArray<TranscriptSegmentInput>,
      summaryContext: string,
      totalTranscriptMs: number,
      images: ReadonlyArray<string> = []
    ) => {
      if (!token || !activeConversationId || contextFull) return;

      // 捕获本次发送绑定的 conversationId —— SSE 流的所有写入都打到这一片，
      // 即使用户流式途中切到别的对话/录音，旧流也只写回已非活跃的切片。
      const conversationId = activeConversationId;

      // 本地立即渲染：正文 + 图片缩略图（用 data URL 直接渲染为 markdown 图片，
      // 与服务端持久化口径一致 —— 服务端会把 data URL 换成磁盘 URL）
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content:
          images.length > 0
            ? `${question}\n\n${images.map((url) => `![image](${url})`).join('\n')}`
            : question,
        timestamp: Date.now(),
      };
      addMessage(conversationId, userMsg);
      setLoading(conversationId, true);

      // 前端预估 token 用量（小圈即时反馈）；budget 取所选模型 contextWindow
      const modelBudget = deriveBudgetFromModel(availableModels, selectedModel);
      const preEstimate = estimateChatUsage({
        systemPrompt: '',
        transcript: transcriptSegments.map((s) => s.text).join(' '),
        summary: summaryContext,
        history: messages,
        userInput: question,
        budget: tokenUsage?.budget || modelBudget,
        level: tokenUsage?.level ?? 1,
      });
      setTokenUsage(conversationId, preEstimate);

      // 占位 assistant 消息，流式增量直接打到它身上
      const assistantId = crypto.randomUUID();
      // 思考耗时：首个 thinking 增量 → 最后一个 thinking 增量之间的时长
      let thinkingFirstAt = 0;
      let thinkingLastAt = 0;
      addMessage(conversationId, {
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        streaming: true,
      });

      // 取消可能仍在进行的上一条发送流，避免切换 session/卸载后旧流写入共享 store。
      sendAbortRef.current?.abort();
      const abortController = new AbortController();
      sendAbortRef.current = abortController;

      try {
        const thinkingFields = preferenceToFields(selectedThinkingPreference);
        const res = await fetch('/api/llm/chat', {
          method: 'POST',
          signal: abortController.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            conversationId: activeConversationId,
            question,
            transcript: transcriptSegments,
            totalTranscriptMs,
            summaryContext,
            model: selectedModel || undefined,
            ...(images.length > 0 ? { images } : {}),
            ...(thinkingFields.thinkingDepth !== undefined
              ? { thinkingDepth: thinkingFields.thinkingDepth }
              : {}),
            ...(thinkingFields.thinkingEnabled !== undefined
              ? { thinkingEnabled: thinkingFields.thinkingEnabled }
              : {}),
          }),
        });

        // 非 SSE 错误响应（鉴权/校验失败等）
        if (
          !res.ok ||
          !res.body ||
          !(res.headers.get('Content-Type') || '').includes('text/event-stream')
        ) {
          const data = await res
            .json()
            .catch(() => ({}) as Record<string, unknown>);
          updateMessage(conversationId, assistantId, {
            content:
              (typeof data.error === 'string' && data.error) ||
              `Chat API returned ${res.status}`,
            streaming: false,
          });
          return;
        }

        let accumulatedText = '';
        let accumulatedThinking = '';
        let sawError = false;

        await consumeSse(res.body, (event, payload) => {
          if (event === 'thinking') {
            const now = Date.now();
            if (!thinkingFirstAt) thinkingFirstAt = now;
            thinkingLastAt = now;
            accumulatedThinking += String(payload.delta ?? '');
            updateMessage(conversationId, assistantId, { thinking: accumulatedThinking });
          } else if (event === 'text') {
            accumulatedText += String(payload.delta ?? '');
            updateMessage(conversationId, assistantId, { content: accumulatedText });
          } else if (event === 'done') {
            const budget =
              typeof payload.budget === 'number' && payload.budget > 0
                ? payload.budget
                : preEstimate.budget;
            const inputTokens =
              typeof payload.inputTokens === 'number'
                ? payload.inputTokens
                : preEstimate.used;
            updateMessage(conversationId, assistantId, {
              streaming: false,
              model:
                typeof payload.model === 'string' ? payload.model : undefined,
              thinkingDepth: payload.thinkingDepth as ThinkingDepth | undefined,
              thinkingMs:
                thinkingFirstAt > 0
                  ? thinkingLastAt - thinkingFirstAt
                  : undefined,
            });
            setTokenUsage(conversationId, {
              used: inputTokens,
              budget,
              level:
                typeof payload.level === 'number'
                  ? payload.level
                  : preEstimate.level,
              breakdown: {
                systemPrompt: 0,
                transcript: 0,
                summary: 0,
                history: inputTokens,
                userInput: 0,
              },
            });
          } else if (event === 'error') {
            sawError = true;
            if (payload.contextFull === true) {
              setContextFull(conversationId, true);
              setTokenUsage(conversationId, { ...preEstimate, level: 7 });
            }
            updateMessage(conversationId, assistantId, {
              content:
                accumulatedText ||
                (typeof payload.error === 'string'
                  ? payload.error
                  : '对话失败，请重试。'),
              streaming: false,
            });
          }
        });

        // 流意外结束但既无 done 也无 error → 收尾占位消息
        if (!sawError) {
          updateMessage(conversationId, assistantId, { streaming: false });
        }
      } catch (error) {
        // 流被 abort（切换 session/卸载）—— 静默收尾，不写错误气泡。
        if ((error as { name?: string })?.name === 'AbortError') return;
        updateMessage(conversationId, assistantId, {
          content: `Error: ${error instanceof Error ? error.message : 'Chat failed'}`,
          streaming: false,
        });
      } finally {
        setLoading(conversationId, false);
      }
    },
    [
      token,
      activeConversationId,
      contextFull,
      messages,
      availableModels,
      selectedModel,
      selectedThinkingPreference,
      tokenUsage,
      addMessage,
      updateMessage,
      setLoading,
      setTokenUsage,
      setContextFull,
    ]
  );

  /* ──────────────────────────────────────────────────────────────
     新建对话（关闭当前活跃 + 新开一个）
     ────────────────────────────────────────────────────────────── */
  const createNewConversation = useCallback(async () => {
    if (!token || !sessionId) return;
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) throw new Error(`create ${res.status}`);
      const data = (await res.json()) as { conversation: ConversationMeta };

      // 标记旧的为 ended（前端立即同步，UI 用）
      const now = new Date().toISOString();
      const updated = conversations.map((c) =>
        c.endedAt === null ? { ...c, endedAt: now } : c
      );
      setConversations([...updated, data.conversation]);
      setActiveConversation(data.conversation.id);
      setMessages(data.conversation.id, [], []);
    } catch (err) {
      console.error('Failed to create conversation:', err);
    }
  }, [
    token,
    sessionId,
    conversations,
    setConversations,
    setActiveConversation,
    setMessages,
  ]);

  /* ──────────────────────────────────────────────────────────────
     切换 conversation（旧的只读查看）
     ────────────────────────────────────────────────────────────── */
  const switchConversation = useCallback(
    async (id: string) => {
      setActiveConversation(id);
      await loadConversationMessages(id);
    },
    [setActiveConversation, loadConversationMessages]
  );

  /* ──────────────────────────────────────────────────────────────
     主动压缩（/compress 命令）
     ────────────────────────────────────────────────────────────── */
  const compressActive = useCallback(
    async (keepTurns = 3): Promise<{ ok: boolean; reason?: string }> => {
      if (!token || !activeConversationId) return { ok: false, reason: 'no_active' };
      try {
        const res = await fetch('/api/llm/chat/compress', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            conversationId: activeConversationId,
            keepTurns,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as
            | { message?: string }
            | null;
          return {
            ok: false,
            reason:
              data?.message ?? `压缩失败 (HTTP ${res.status})。建议新建对话。`,
          };
        }
        const data = (await res.json()) as {
          compressed: boolean;
          summary?: string;
          keptTurns?: number;
          reason?: string;
        };
        if (!data.compressed) {
          return { ok: false, reason: data.reason ?? '历史太短，无需压缩' };
        }
        // 重新拉取消息（now archivedMessages 会包含原历史，messages 是保留的最近 N 轮）
        await loadConversationMessages(activeConversationId);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [token, activeConversationId, loadConversationMessages]
  );

  /* 暴露给 /keyword 等命令：注入当前活跃对话 id，对外保持旧 (message) 签名 */
  const addMessageToActive = useCallback(
    (message: ChatMessage) => {
      if (activeConversationId) addMessage(activeConversationId, message);
    },
    [activeConversationId, addMessage]
  );

  return {
    // state
    isLoading,
    selectedModel,
    selectedThinkingPreference,
    availableModels,
    modelsLoaded,
    activeConversationId,
    conversations,
    messages,
    archivedMessages,
    tokenUsage,
    contextFull,
    // actions
    sendMessage,
    setSelectedModel,
    setSelectedThinkingPreference,
    createNewConversation,
    switchConversation,
    compressActive,
    addMessage: addMessageToActive, // 暴露给 /keyword 等命令保留旧 (message) 用法
  };
}

/* ------------------------------------------------------------------ */
/*  SSE 流消费                                                          */
/* ------------------------------------------------------------------ */

/**
 * 逐帧读取 SSE 响应。每个 `event:`+`data:` 帧解析后回调 onEvent。
 */
async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, payload: Record<string, unknown>) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flushFrame = (frame: string) => {
    let event = 'message';
    let dataLine = '';
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLine += line.slice(5).trim();
      }
    }
    if (!dataLine) return;
    try {
      onEvent(event, JSON.parse(dataLine) as Record<string, unknown>);
    } catch {
      // 忽略无法解析的帧
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 帧以空行（\n\n）分隔
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      flushFrame(frame);
    }
  }
  if (buffer.trim()) flushFrame(buffer);
}
