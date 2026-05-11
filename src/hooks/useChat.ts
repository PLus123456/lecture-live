'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useChatStore } from '@/stores/chatStore';
import type { ConversationMeta } from '@/stores/chatStore';
import { useAuthStore } from '@/stores/authStore';
import type { ChatMessage, ChatModelsResponse, ThinkingDepth } from '@/types/llm';
import { estimateTokens } from '@/lib/llm/tokenizer';

interface TranscriptSegmentInput {
  text: string;
  startMs: number;
}

/**
 * 把 chat 历史 + 当前输入估算成 token 用量。仅用于小圈 UI 展示，
 * 真实预算判定在服务端 chatContextBuilder 里。
 *
 * budget 由调用方传入（来自模型 contextWindow × 0.8）—— 客户端拿不到具体
 * provider 信息时给一个保守值（如 16384 × 0.8 = 13107）。
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

/** 客户端保守 budget（实际预算由服务端模型决定，前端 UI 仅作展示） */
const CLIENT_FALLBACK_BUDGET = 13107;

export function useChat(sessionId: string | null) {
  const {
    isLoading,
    selectedModel,
    selectedDepth,
    availableModels,
    modelsLoaded,
    activeConversationId,
    conversations,
    messages,
    archivedMessages,
    tokenUsage,
    contextFull,
    setLoading,
    setSelectedModel,
    setSelectedDepth,
    setAvailableModels,
    setActiveConversation,
    setConversations,
    addConversation,
    setMessages,
    addMessage,
    setTokenUsage,
    setContextFull,
    resetSession,
  } = useChatStore();

  const token = useAuthStore((s) => s.token);
  const lastLoadedSessionRef = useRef<string | null>(null);

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
            createdAt: string;
          }>;
        };

        // 找最近一条 system → 分割成 archivedMessages + messages
        let lastSystemIdx = -1;
        for (let i = data.messages.length - 1; i >= 0; i--) {
          if (data.messages[i].role === 'system') {
            lastSystemIdx = i;
            break;
          }
        }

        const toChatMessage = (raw: (typeof data.messages)[number]): ChatMessage => ({
          id: raw.id,
          role: raw.role === 'assistant' ? 'assistant' : 'user',
          content: raw.content,
          timestamp: new Date(raw.createdAt).getTime(),
        });

        const archived = data.messages
          .slice(0, Math.max(0, lastSystemIdx))
          .filter((m) => m.role !== 'system')
          .map(toChatMessage);
        const visible = data.messages
          .slice(lastSystemIdx + 1)
          .filter((m) => m.role !== 'system')
          .map(toChatMessage);

        setMessages(visible, archived);
      } catch (err) {
        console.error('Failed to load conversation messages:', err);
      }
    },
    [token, setMessages]
  );

  /* ──────────────────────────────────────────────────────────────
     发送消息
     ────────────────────────────────────────────────────────────── */
  const sendMessage = useCallback(
    async (
      question: string,
      transcriptSegments: ReadonlyArray<TranscriptSegmentInput>,
      summaryContext: string,
      totalTranscriptMs: number
    ) => {
      if (!token || !activeConversationId || contextFull) return;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: question,
        timestamp: Date.now(),
      };
      addMessage(userMsg);
      setLoading(true);

      // 前端预估 token 用量（用于小圈即时反馈）
      const preEstimate = estimateChatUsage({
        systemPrompt: '',
        transcript: transcriptSegments.map((s) => s.text).join(' '),
        summary: summaryContext,
        history: messages,
        userInput: question,
        budget: tokenUsage?.budget ?? CLIENT_FALLBACK_BUDGET,
        level: tokenUsage?.level ?? 1,
      });
      setTokenUsage(preEstimate);

      try {
        const res = await fetch('/api/llm/chat', {
          method: 'POST',
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
            thinkingDepth: selectedDepth,
          }),
        });

        if (res.status === 413) {
          // 上下文已满：提示用户新建对话
          setContextFull(true);
          // 把 level 提到 L7（EOL），让小圈紫色 + L7 与红色横幅语义一致 —
          // 否则 preEstimate 留下的 L1 会让用户看到"L1 但上下文炸了"的困惑。
          setTokenUsage({ ...preEstimate, level: 7 });
          const data = await res.json().catch(() => ({} as Record<string, unknown>));
          const assistantMsg: ChatMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content:
              (typeof data.message === 'string' && data.message) ||
              '当前对话上下文已满，建议新建对话继续。',
            timestamp: Date.now(),
          };
          addMessage(assistantMsg);
          return;
        }

        if (!res.ok) throw new Error(`Chat API returned ${res.status}`);

        const data = (await res.json()) as {
          reply: string;
          thinking: string | null;
          model: string;
          thinkingDepth: ThinkingDepth;
          level: number;
        };

        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: data.reply,
          timestamp: Date.now(),
          model: data.model,
          thinkingDepth: data.thinkingDepth,
          thinking: data.thinking ?? undefined,
        };
        addMessage(assistantMsg);

        // 更新 token usage（用服务端反馈的 level）
        setTokenUsage({ ...preEstimate, level: data.level });
      } catch (error) {
        const errMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : 'Chat failed'}`,
          timestamp: Date.now(),
        };
        addMessage(errMsg);
      } finally {
        setLoading(false);
      }
    },
    [
      token,
      activeConversationId,
      contextFull,
      messages,
      selectedModel,
      selectedDepth,
      tokenUsage,
      addMessage,
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
      setMessages([], []);
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

  return {
    // state
    isLoading,
    selectedModel,
    selectedDepth,
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
    setSelectedDepth,
    createNewConversation,
    switchConversation,
    compressActive,
    addMessage, // 暴露给 /keyword 等命令保留旧用法
  };
}
