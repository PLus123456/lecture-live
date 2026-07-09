'use client';

// TODO U-refactor: 提取 ChatPanel 公共组件 —— 当前 GlobalChat 与
// src/components/session/ChatTab.tsx 共享约 70% 的视觉/交互代码。
// 为了不破坏 ChatTab，本单元（U10）选择"复制 + 局部适配"的方案。
// 待 U12 流式 chat 端点统一接受 conversationId 后，再把 popover、
// 思考块、消息气泡、模型菜单抽到 src/components/chat/ChatPanel.tsx。

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import {
  ArrowUp,
  Square,
  Loader2,
  Bot,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Sparkles,
  Check,
  ImagePlus,
  X,
  Paperclip,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useAuthStore } from '@/stores/authStore';
import { useConversationListStore } from '@/stores/conversationListStore';
import {
  useChatStore,
  preferenceToFields,
  EMPTY_CONVERSATION_RUNTIME,
  type ThinkingPreference,
} from '@/stores/chatStore';
import { findCompressionBoundary } from '@/lib/llm/chatCompression';
import { toast } from '@/stores/toastStore';
import type {
  ChatMessage,
  ChatModelOption,
  ChatModelsResponse,
  ThinkingDepth,
  ThinkingMode,
} from '@/types/llm';
import AttachmentChip, { type AttachmentChipData } from './AttachmentChip';
import RecordingsBar, { type RecordingPill } from './RecordingsBar';
import RecordingPicker from './RecordingPicker';

/* ------------------------------------------------------------------ */
/*  图片上传约束（与服务端 LLM_LIMITS 对齐 — 与 ChatTab 同步）              */
/* ------------------------------------------------------------------ */
const MAX_CHAT_IMAGES = 4;
const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
];

/* ------------------------------------------------------------------ */
/*  附件文件类型白名单（U5 服务端会复核）                                  */
/* ------------------------------------------------------------------ */
const ACCEPTED_FILE_TYPES = [
  // PDF
  'application/pdf',
  // Word
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  // Excel
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  // PowerPoint
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  // 纯文本 / 代码（text/* 通配在 accept 字符串里）
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/x-yaml',
  'text/yaml',
];
const ACCEPT_FILE_INPUT_STRING = [
  ...ACCEPTED_FILE_TYPES,
  'text/*',
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.py',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.go',
  '.rs',
  '.java',
  '.cpp',
  '.c',
  '.h',
].join(',');

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB（U13 会从 SiteSetting 拉到真实上限）

/** 把 File 读成 base64 data URL — 与 ChatTab 同步 */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * 从所选模型的 contextWindow 推导前端展示用的 inputBudget，用作 tokenUsage 种子的
 * budget（消费方据此算百分比；进入对话即真实而非 0%）。无可用模型信息时返回 0。
 *
 * 口径与服务端 tokenBudget.computeContextBudget 一致（与 useChat.ts 同步）：
 *   inputBudget = (contextWindow - outputMaxTokens) × 0.8
 * tokenBudget.ts 标了 server-only，故此处内联同样的算式（仅用于 UI 展示）。
 */
function deriveBudgetFromModel(
  models: ReadonlyArray<ChatModelOption>,
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

/* ------------------------------------------------------------------ */
/*  Markdown 渲染（从 ChatTab 同步过来；保持视觉一致）                      */
/* ------------------------------------------------------------------ */

/** 过滤 markdown 链接 href —— 只放行 http/https/mailto/锚点/相对链接，
 *  丢弃 javascript: / data: 等可执行协议（LLM 输出不可信）。 */
function safeHref(href: unknown): string | undefined {
  if (typeof href !== 'string') return undefined;
  return /^(https?:|mailto:|#|\/)/i.test(href.trim()) ? href : undefined;
}

function Md({ children }: { children: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children: c }) => <p className="mb-2 last:mb-0">{c}</p>,
        strong: ({ children: c }) => (
          <strong className="font-semibold">{c}</strong>
        ),
        em: ({ children: c }) => <em className="italic">{c}</em>,
        ul: ({ children: c }) => (
          <ul className="list-disc list-inside mb-2 space-y-1">{c}</ul>
        ),
        ol: ({ children: c }) => (
          <ol className="list-decimal list-inside mb-2 space-y-1">{c}</ol>
        ),
        li: ({ children: c }) => <li>{c}</li>,
        code: ({ children: c, className: codeClass }) => {
          const isInline = !codeClass;
          return isInline ? (
            <code className="px-1 py-0.5 rounded bg-charcoal-100 text-rust-600 text-xs font-mono">
              {c}
            </code>
          ) : (
            <code className={codeClass}>{c}</code>
          );
        },
        pre: ({ children: c }) => (
          <pre className="my-2 p-3 rounded-lg bg-charcoal-800 text-cream-100 text-xs font-mono overflow-x-auto">
            {c}
          </pre>
        ),
        blockquote: ({ children: c }) => (
          <blockquote className="border-l-2 border-rust-300 pl-3 my-2 text-charcoal-500 italic">
            {c}
          </blockquote>
        ),
        h1: ({ children: c }) => (
          <h1 className="font-bold text-base mb-1.5">{c}</h1>
        ),
        h2: ({ children: c }) => (
          <h2 className="font-bold text-sm mb-1">{c}</h2>
        ),
        h3: ({ children: c }) => (
          <h3 className="font-semibold text-sm mb-0.5">{c}</h3>
        ),
        a: ({ href, children: c }) => (
          <a
            href={safeHref(href)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-rust-500 underline hover:text-rust-700"
          >
            {c}
          </a>
        ),
        hr: () => <hr className="my-2 border-charcoal-200" />,
        img: ({ src, alt }) =>
          src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={typeof src === 'string' ? src : undefined}
              alt={alt || 'image'}
              className="my-1.5 rounded-md max-w-full max-h-64 object-contain border border-cream-200"
            />
          ) : null,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

/* ------------------------------------------------------------------ */
/*  ThinkingBlock —— 与 ChatTab 同步                                    */
/* ------------------------------------------------------------------ */

function ThinkingBlock({
  thinking,
  streaming,
  thinkingMs,
}: {
  thinking: string;
  streaming?: boolean;
  thinkingMs?: number;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? Boolean(streaming);

  const seconds =
    typeof thinkingMs === 'number' && thinkingMs > 0
      ? Math.max(1, Math.round(thinkingMs / 1000))
      : null;
  const label = streaming
    ? '思考中…'
    : seconds != null
      ? `已深度思考 ${seconds} 秒`
      : '查看思考过程';

  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setOverride(!expanded)}
        className="flex items-center gap-1 text-[11px] text-charcoal-400
                   hover:text-charcoal-600 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        <Sparkles
          className={`w-3 h-3 text-purple-400 ${streaming ? 'animate-breathe' : ''}`}
        />
        <span className="font-medium">{label}</span>
      </button>
      {expanded && (
        <div
          className="mt-1 ml-[7px] pl-3 border-l-2 border-purple-100
                     text-[11px] leading-relaxed text-charcoal-500
                     max-h-[280px] overflow-y-auto"
        >
          {thinking ? (
            <Md>{thinking}</Md>
          ) : (
            <span className="text-charcoal-300 italic">准备思考…</span>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  消息气泡 —— 与 ChatTab 同步                                          */
/* ------------------------------------------------------------------ */

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end animate-chat-bubble-right">
        <div
          className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-md text-sm leading-relaxed
                     bg-charcoal-800 text-white chat-user-bubble"
        >
          <Md>{msg.content}</Md>
        </div>
      </div>
    );
  }

  const showStreamingPlaceholder = msg.streaming && !msg.content;

  return (
    <div className="animate-chat-bubble-left min-w-0">
      {msg.thinking !== undefined && (
        <ThinkingBlock
          thinking={msg.thinking}
          streaming={msg.streaming}
          thinkingMs={msg.thinkingMs}
        />
      )}
      {showStreamingPlaceholder && msg.thinking === undefined && (
        <div className="flex items-center gap-1.5 text-xs text-charcoal-400 mb-1">
          <Sparkles className="w-3.5 h-3.5 text-purple-400 animate-breathe" />
          <span>思考中…</span>
        </div>
      )}
      {msg.content && (
        <div className="text-sm leading-relaxed text-charcoal-800">
          <Md>{msg.content}</Md>
        </div>
      )}
      {msg.model && !msg.streaming && (
        <div className="flex items-center gap-1.5 mt-1">
          <span className="text-[10px] text-charcoal-300">{msg.model}</span>
          {msg.thinkingDepth && msg.thinkingDepth !== 'medium' && (
            <span
              className={`text-[10px] px-1 py-0.5 rounded ${
                msg.thinkingDepth === 'high'
                  ? 'bg-purple-50 text-purple-500'
                  : 'bg-cream-100 text-charcoal-400'
              }`}
            >
              {msg.thinkingDepth}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Thinking 偏好 → 显示元数据 —— 与 ChatTab 同步                          */
/* ------------------------------------------------------------------ */

function thinkingOptionsForMode(mode: ThinkingMode): Array<{
  pref: ThinkingPreference;
  label: string;
  description: string;
  disabled?: boolean;
  disabledTitle?: string;
}> {
  if (mode === 'DEPTH') {
    return [
      { pref: 'off', label: '不思考', description: '快速答复（OpenAI 会发 minimal effort）' },
      { pref: 'low', label: '低', description: '少量思考 token' },
      { pref: 'medium', label: '中', description: '默认深度' },
      { pref: 'high', label: '高', description: '最深思考，速度较慢' },
    ];
  }
  if (mode === 'AUTO') {
    return [
      { pref: 'off', label: '不思考', description: '强制不带思考参数' },
      { pref: 'auto', label: '自动', description: '让模型自己决定' },
      { pref: 'forced', label: '强制思考', description: '尽可能启用深度思考' },
    ];
  }
  return [
    {
      pref: 'off',
      label: '不思考',
      description: '该模型自带思考无法关闭',
      disabled: true,
      disabledTitle: '该模型自带思考，无法关闭',
    },
    { pref: 'auto', label: '自动', description: '让模型自己决定' },
    { pref: 'forced', label: '强制思考', description: '尽可能启用深度思考' },
  ];
}

/* ------------------------------------------------------------------ */
/*  SSE 流消费 —— 与 useChat.ts 同步                                     */
/* ------------------------------------------------------------------ */

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
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      flushFrame(frame);
    }
  }
  if (buffer.trim()) flushFrame(buffer);
}

/* ------------------------------------------------------------------ */
/*  GlobalChat 主组件                                                   */
/* ------------------------------------------------------------------ */

export default function GlobalChat({
  conversationId,
  onAccessDenied,
}: {
  conversationId: string;
  /** messages 拉取返回 404/403（无权/不存在）时回调，由父组件决定跳转。 */
  onAccessDenied?: () => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const token = useAuthStore((s) => s.token);

  // Zustand chat store — 偏好/模型列表全局共享；运行时态按 conversationId 隔离
  const {
    selectedModel,
    selectedThinkingPreference,
    availableModels,
    modelsLoaded,
    byConversation,
    setSelectedModel,
    setSelectedThinkingPreference,
    setAvailableModels,
    setActiveConversation,
    setMessages,
    addMessage,
    updateMessage,
    setLoading,
    setTokenUsage,
    resetConversation,
    setContextFull,
  } = useChatStore();

  // 本对话的运行时切片 —— messages/archivedMessages/isLoading/contextFull 全从这里取（不再读全局单例）
  // U19：此前漏读 archivedMessages，压缩过的对话里早期历史被永久隐藏、无展开入口。
  const { messages, archivedMessages, isLoading, contextFull } =
    byConversation[conversationId] ?? EMPTY_CONVERSATION_RUNTIME;

  /* ── 局部 UI state ── */
  const [input, setInput] = useState('');
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showThinkingMenu, setShowThinkingMenu] = useState(false);
  /** 已选待发送的图片（base64 data URL 数组） */
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  /** 已上传成功的文件附件（U5 服务端返回的元数据） */
  const [attachments, setAttachments] = useState<AttachmentChipData[]>([]);
  /** 当前对话挂载的录音 pill 列表 */
  const [recordings, setRecordings] = useState<RecordingPill[]>([]);
  /** API 子路由是否可用（U9 未上线时显示禁用按钮） */
  const [recordingsReady, setRecordingsReady] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  /** 「添加录音」选择器是否打开（U11 接线 RecordingPicker） */
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 对话已关闭（endedAt 非空）→ 只读：禁止再发消息 / 改附件。null = 活跃。 */
  const [endedAt, setEndedAt] = useState<string | null>(null);
  const isEnded = endedAt !== null;
  /**
   * 历史消息是否已加载完成（含失败兜底）。加载完成前禁止发送：否则 GET /messages
   * 返回后的 setMessages 全量覆盖会清掉刚发送的乐观消息与流式占位，SSE 增量
   * updateMessage 因 id 不存在而全部落空（消息凭空消失、loader 卡死、诱导重发）。
   * ref 供 handleSend 同步判断（effect 闭包里的 state 是旧值），state 供按钮态渲染。
   */
  const historyLoadedRef = useRef(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  /** IME 合成中（中文/日文输入法）—— 合成期间回车不应发送（修输入法回车误发） */
  const [composing, setComposing] = useState(false);
  /** U19：主动压缩后被折叠的早期消息是否展开（与 ChatTab 的 展开/收起 一致） */
  const [showArchived, setShowArchived] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /**
   * U79：记录最近一次 compositionend 的时间戳。Safari 的事件顺序是
   * compositionend → keydown（Chrome 相反），确认 IME 候选词的那次 Enter 到达 keydown 时
   * composing 已被重置、e.nativeEvent.isComposing 也已是 false，两道 IME 守卫双双失效，
   * 导致 Safari 下"回车确认候选词"被误当成发送。用时间戳窗口把紧随 compositionend 的
   * Enter 视为合成确认而非发送。
   */
  const lastCompositionEndRef = useRef(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sendAbortRef = useRef<AbortController | null>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ──────────────────────────────────────────────────────────────
     一次性：拉取模型列表
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
        console.error('Failed to load chat models:', err);
      });
  }, [token, modelsLoaded, setAvailableModels]);

  /* ──────────────────────────────────────────────────────────────
     conversationId 变化时：重置 + 并行拉消息 + 录音 pill
     —— AbortController 负责取消 strict-mode 重入产生的旧请求。
     ────────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!token) return;
    // 只重置本对话的切片（不动其它对话），再设为活跃。
    resetConversation(conversationId);
    setActiveConversation(conversationId);
    setAttachments([]);
    setEndedAt(null);
    historyLoadedRef.current = false;
    setHistoryLoaded(false);

    const controller = new AbortController();
    const headers = { Authorization: `Bearer ${token}` };

    // 并行：messages（必存）+ recordings（U9 才上线，404 静默）
    void Promise.all([
      (async () => {
        try {
          const res = await fetch(
            `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
            { headers, signal: controller.signal }
          );
          if (controller.signal.aborted) return;
          if (!res.ok) {
            // 404/403 = 对话不存在或无权访问 → 通知父组件跳转（替代此前在
            // ChatDetailClient 里的重复预检请求，避免每次进对话发两次 messages）。
            if (res.status === 404 || res.status === 403) {
              onAccessDenied?.();
            } else {
              // 5xx 等服务端错误：给出可见反馈，与真正的空对话区分开
              toast.error(t('chat.loadFailed'), `HTTP ${res.status}`);
            }
            setMessages(conversationId, [], []);
            historyLoadedRef.current = true;
            setHistoryLoaded(true);
            // 首页暂存的首条消息发不出去了 → 放回输入框，避免文本丢失
            const orphaned = useChatStore
              .getState()
              .takePendingFirstMessage(conversationId);
            if (orphaned) setInput(orphaned.text);
            return;
          }
          const data = (await res.json()) as {
            conversation?: { endedAt: string | null };
            messages: Array<{
              id: string;
              role: string;
              content: string;
              degradationLevel: number | null;
              inputTokens: number | null;
              createdAt: string;
            }>;
          };
          if (controller.signal.aborted) return;
          // 已关闭对话 → 置只读（endedAt 非空）
          setEndedAt(data.conversation?.endedAt ?? null);

          // 找最近一条压缩边界 → 分割成 archivedMessages + messages（与 useChat.ts 同步）。
          // 此前 archived 恒传 []：压缩过的对话会把摘要切割点之前的历史全当可见消息
          // 渲染，且 archivedMessages 切片永远为空（消费方拿不到“已折叠 N 条”）。
          const compressionBoundary = findCompressionBoundary(data.messages);
          const toChatMessage = (
            raw: (typeof data.messages)[number]
          ): ChatMessage => ({
            id: raw.id,
            role: raw.role === 'assistant' ? 'assistant' : 'user',
            content: raw.content,
            timestamp: new Date(raw.createdAt).getTime(),
          });
          const archived: ChatMessage[] = data.messages
            .slice(0, compressionBoundary.splitIndex + 1)
            .filter((m) => m.role !== 'system')
            .map(toChatMessage);
          const visible: ChatMessage[] = data.messages
            .slice(compressionBoundary.splitIndex + 1)
            .filter((m) => m.role !== 'system')
            .map(toChatMessage);
          setMessages(conversationId, visible, archived);

          // 用最后一条 assistant 消息的 inputTokens 作为已用量种子，budget 由所选模型的
          // contextWindow 推导（与 useChat.ts 同步）—— 此前从不 setTokenUsage，消费方进入
          // 对话只能读到 null（百分比 0%）；现在一进来就拿到真实已用量。
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

          // 历史加载完成 → 解锁发送（必须先于自动发送置位，handleSend 有门闩守卫）
          historyLoadedRef.current = true;
          setHistoryLoaded(true);

          // Claude 式起聊：首页 composer 暂存的首条消息在加载完成后自动发送。
          // takePendingFirstMessage 取到即清空 —— StrictMode 首次挂载的 effect
          // 在 fetch 返回前就被 abort（走不到这里），只有存活的那次拿到文本。
          const pending = useChatStore
            .getState()
            .takePendingFirstMessage(conversationId);
          if (pending) {
            if (
              data.messages.length === 0 &&
              (data.conversation?.endedAt ?? null) === null &&
              // 新鲜度守卫：加载途中切走留下的陈旧残留，数小时后重开该对话时
              // 不应突然自动发送 —— 放回输入框由用户决定。
              pending.ageMs < 60_000
            ) {
              void handleSend(pending.text);
            } else {
              setInput(pending.text);
            }
          }
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          console.error('Failed to load conversation messages:', err);
          toast.error(t('chat.loadFailed'));
          setMessages(conversationId, [], []);
          historyLoadedRef.current = true;
          setHistoryLoaded(true);
          // 加载失败时把暂存的首条消息还给输入框，避免文本丢失
          const orphaned = useChatStore
            .getState()
            .takePendingFirstMessage(conversationId);
          if (orphaned) setInput(orphaned.text);
        }
      })(),
      (async () => {
        try {
          const res = await fetch(
            `/api/conversations/${encodeURIComponent(conversationId)}/recordings`,
            { headers, signal: controller.signal }
          );
          if (controller.signal.aborted) return;
          if (!res.ok) {
            setRecordings([]);
            setRecordingsReady(false);
            return;
          }
          const data: unknown = await res.json();
          if (controller.signal.aborted) return;
          let raw: unknown[] = [];
          if (Array.isArray(data)) {
            raw = data;
          } else if (data && typeof data === 'object') {
            const obj = data as Record<string, unknown>;
            if (Array.isArray(obj.recordings)) raw = obj.recordings;
            else if (Array.isArray(obj.items)) raw = obj.items;
          }
          const list = raw.filter(
            (r): r is RecordingPill =>
              !!r &&
              typeof r === 'object' &&
              typeof (r as RecordingPill).sessionId === 'string'
          );
          setRecordings(list);
          setRecordingsReady(true);
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          setRecordings([]);
          setRecordingsReady(false);
        }
      })(),
      (async () => {
        // C10：回填已上传的附件 chips。此前刷新后 setAttachments([]) 从不重新拉取，
        // 导致刷新前上传的附件 chip 消失、无法删除；且下次发送 attachmentIds 只带新附件，
        // 会把 where 收窄、静默把旧附件从 LLM 上下文里丢掉。这里进对话就把已有附件拉回。
        try {
          const res = await fetch(
            `/api/chat-uploads?conversationId=${encodeURIComponent(conversationId)}`,
            { headers, signal: controller.signal }
          );
          if (controller.signal.aborted) return;
          if (!res.ok) {
            // 404（端点未上线）或其它错误 → 保持空列表，不打断对话加载。
            return;
          }
          const data = (await res.json()) as {
            attachments?: Array<{
              id?: string;
              fileName?: string;
              bytes?: number | string;
              kind?: 'image' | 'document' | 'text';
            }>;
          };
          if (controller.signal.aborted) return;
          const chips: AttachmentChipData[] = (data.attachments ?? [])
            .filter((a): a is { id: string } & typeof a => typeof a.id === 'string')
            .map((a) => ({
              id: a.id,
              fileName: a.fileName ?? a.id,
              bytes:
                typeof a.bytes === 'string'
                  ? parseInt(a.bytes, 10) || 0
                  : a.bytes ?? 0,
              kind: a.kind ?? 'document',
            }));
          setAttachments(chips);
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          // best-effort：拉取失败保持空列表，不影响其它加载。
        }
      })(),
    ]);

    return () => {
      controller.abort();
      // 切换对话/卸载时中止仍在进行的发送流（切片已按 conversationId 隔离，旧流即便
      // 漏写也只落到自己那片不污染当前对话；abort 仍保留以省掉无谓的流式开销）。
      sendAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, conversationId]);

  /* ──────────────────────────────────────────────────────────────
     自动滚到最新消息
     ────────────────────────────────────────────────────────────── */
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* ──────────────────────────────────────────────────────────────
     Outside-click 关闭 popover —— 与 ChatTab 同步
     ────────────────────────────────────────────────────────────── */
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    if (showModelMenu) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [showModelMenu]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        thinkingMenuRef.current &&
        !thinkingMenuRef.current.contains(e.target as Node)
      ) {
        setShowThinkingMenu(false);
      }
    };
    if (showThinkingMenu) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [showThinkingMenu]);

  /* ──────────────────────────────────────────────────────────────
     图片上传：选择 / 粘贴 / 删除 —— 与 ChatTab 同步逻辑
     ────────────────────────────────────────────────────────────── */
  const currentModelInfo = availableModels.find((m) => m.name === selectedModel);
  const currentModelLabel = currentModelInfo?.displayName || selectedModel || 'Default';
  const currentThinkingMode: ThinkingMode = currentModelInfo?.thinkingMode ?? 'NONE';
  const supportsImage = Boolean(currentModelInfo?.supportsImage);

  const addImageFiles = async (files: FileList | File[]) => {
    setImageError(null);
    const incoming = Array.from(files).filter((f) =>
      ACCEPTED_IMAGE_TYPES.includes(f.type)
    );
    if (incoming.length === 0) return;
    const accepted: string[] = [];
    for (const file of incoming) {
      if (file.size > MAX_CHAT_IMAGE_BYTES) {
        setImageError('单张图片不能超过 5MB');
        continue;
      }
      if (pendingImages.length + accepted.length >= MAX_CHAT_IMAGES) {
        setImageError(`最多上传 ${MAX_CHAT_IMAGES} 张图片`);
        break;
      }
      try {
        accepted.push(await readFileAsDataUrl(file));
      } catch {
        setImageError('图片读取失败');
      }
    }
    if (accepted.length > 0) {
      setPendingImages((prev) => [...prev, ...accepted].slice(0, MAX_CHAT_IMAGES));
    }
  };

  const handleImagePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void addImageFiles(e.target.files);
    }
    e.target.value = '';
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!supportsImage) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      void addImageFiles(imageFiles);
    }
  };

  const removePendingImage = (index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  };

  /* ──────────────────────────────────────────────────────────────
     文件附件上传（POST /api/chat-uploads — U5 单元）
     U5 未上线时静默兜底：toast.error + 不入列
     ────────────────────────────────────────────────────────────── */
  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !token) return;

    if (file.size > MAX_FILE_BYTES) {
      toast.error(t('chat.fileTooLarge'));
      return;
    }

    setUploadingFile(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('conversationId', conversationId);
      const res = await fetch('/api/chat-uploads', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });

      if (!res.ok) {
        // U5 未上线（404）或 4xx/5xx 都静默 toast 提示
        toast.error(t('chat.uploadFailed'));
        return;
      }

      // /api/chat-uploads 返回扁平结构 { attachmentId, fileName, bytes, kind, ... }
      // （契约见 route 测试）。此前误读 data.attachment.* 导致上传成功也判失败。
      const data = (await res.json()) as {
        attachmentId?: string;
        fileName?: string;
        bytes?: number | string;
        kind?: 'image' | 'document' | 'text';
      };
      if (!data.attachmentId) {
        toast.error(t('chat.uploadFailed'));
        return;
      }
      const newChip: AttachmentChipData = {
        id: data.attachmentId,
        fileName: data.fileName ?? file.name,
        bytes:
          typeof data.bytes === 'string'
            ? parseInt(data.bytes, 10) || 0
            : data.bytes ?? file.size,
        kind: data.kind ?? 'document',
      };
      setAttachments((prev) => [...prev, newChip]);
    } catch {
      toast.error(t('chat.uploadFailed'));
    } finally {
      setUploadingFile(false);
    }
  };

  /**
   * 移除一个已上传附件：乐观从本地移除 + DELETE /api/chat-uploads/[id]
   * （删 Cloudreve 文件 + 释放配额）。此前只删本地数组 → 取消即留 Cloudreve 孤儿文件。
   * 失败回滚并 toast。
   */
  const removeAttachment = useCallback(
    async (id: string) => {
      if (!token) return;
      const prev = attachments;
      setAttachments((cur) => cur.filter((a) => a.id !== id));
      try {
        const res = await fetch(
          `/api/chat-uploads/${encodeURIComponent(id)}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        setAttachments(prev); // 回滚
        toast.error(t('common.operationFailed'));
      }
    },
    [attachments, token, t]
  );

  /* ──────────────────────────────────────────────────────────────
     录音 pill：移除（DELETE /api/conversations/[id]/recordings）
     乐观删除 + 失败回滚（U9 未上线时按 404 处理：toast + 回滚）。
     ────────────────────────────────────────────────────────────── */
  const handleDetachRecording = useCallback(
    async (sessionId: string) => {
      if (!token) return;
      const prevList = recordings;
      // 乐观更新
      setRecordings((cur) => cur.filter((r) => r.sessionId !== sessionId));
      try {
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/recordings`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            // DELETE 路由要求 { sessionIds: string[] }（与 RecordingPicker 一致）。
            body: JSON.stringify({ sessionIds: [sessionId] }),
          }
        );
        if (!res.ok) {
          setRecordings(prevList);
          toast.error(t('common.operationFailed'));
        }
      } catch {
        setRecordings(prevList);
        toast.error(t('common.networkError'));
      }
    },
    [conversationId, token, t, recordings]
  );

  /* ──────────────────────────────────────────────────────────────
     重新拉取录音 pill（RecordingPicker 附加成功后刷新带 title/duration 的完整 pill）
     ────────────────────────────────────────────────────────────── */
  const reloadRecordings = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/recordings`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      // 响应到达时用户可能已切到别的对话（组件实例不卸载，仅 prop 变化）——
      // 迟到的旧对话响应不允许写进新对话的 recordings 状态。
      if (useChatStore.getState().activeConversationId !== conversationId) {
        return;
      }
      if (!res.ok) return;
      const data: unknown = await res.json();
      let raw: unknown[] = [];
      if (Array.isArray(data)) {
        raw = data;
      } else if (data && typeof data === 'object') {
        const obj = data as Record<string, unknown>;
        if (Array.isArray(obj.recordings)) raw = obj.recordings;
        else if (Array.isArray(obj.items)) raw = obj.items;
      }
      const list = raw.filter(
        (r): r is RecordingPill =>
          !!r &&
          typeof r === 'object' &&
          typeof (r as RecordingPill).sessionId === 'string'
      );
      setRecordings(list);
    } catch {
      /* ignore — 刷新失败保留旧 pill，不影响主流程 */
    }
  }, [token, conversationId]);

  /* ──────────────────────────────────────────────────────────────
     新建对话（EOL 后引导）：带上当前录音另起一个全局对话并跳转
     ────────────────────────────────────────────────────────────── */
  const handleNewConversation = useCallback(async () => {
    if (!token) return;
    try {
      const recordingIds = recordings.map((r) => r.sessionId);
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(recordingIds.length > 0 ? { recordingIds } : {}),
      });
      if (!res.ok) throw new Error(`create ${res.status}`);
      const data = (await res.json()) as { conversation: { id: string } };
      // 强刷共享列表：路由变化触发的侧栏刷新不带 force，可能被 1.5s 去抖吞掉
      void useConversationListStore.getState().refresh(token, { force: true });
      router.push(`/chat/${data.conversation.id}`);
    } catch {
      toast.error(t('common.operationFailed'));
    }
  }, [token, recordings, router, t]);

  /* ──────────────────────────────────────────────────────────────
     发送消息（POST /api/llm/chat — SSE 流）
     U12 之前的端点要求 conversation.session 非空；纯全局 chat
     可能返回 404，本组件会把错误内容显示到占位 assistant 气泡里。
     ────────────────────────────────────────────────────────────── */
  const handleSend = async (textOverride?: string) => {
    const value = (textOverride ?? input).trim();
    const hasImages = pendingImages.length > 0;
    if (
      (!value && !hasImages) ||
      isLoading ||
      !token ||
      contextFull ||
      isEnded ||
      // 历史未加载完不发（防 setMessages 全量覆盖清掉乐观消息，见 historyLoadedRef 注释）
      !historyLoadedRef.current ||
      // 附件上传中不发：此时 attachments 还没有该文件的 chip，这条消息会静默丢附件
      uploadingFile
    )
      return;

    // 本对话是否还没有任何 assistant 回复（用于完成后触发标题自动生成）。
    // 不用 messages.length === 0：首轮失败/被停止时服务端已持久化 user 消息，
    // 按长度判定会让该对话永远错过自动标题（服务端幂等，已有标题直接返回）。
    const isFirstExchange = !messages.some((m) => m.role === 'assistant');

    if (textOverride === undefined) {
      setInput('');
      if (composerRef.current) composerRef.current.style.height = 'auto';
    }

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content:
        pendingImages.length > 0
          ? `${value}\n\n${pendingImages.map((url) => `![image](${url})`).join('\n')}`
          : value,
      timestamp: Date.now(),
    };
    addMessage(conversationId, userMsg);
    setLoading(conversationId, true);

    const assistantId = crypto.randomUUID();
    let thinkingFirstAt = 0;
    let thinkingLastAt = 0;
    addMessage(conversationId, {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
    });

    const questionText = value || (hasImages ? '请看图片。' : value);
    const imagesToSend = pendingImages;
    setPendingImages([]);
    setImageError(null);

    // 取消可能仍在进行的上一条发送流，避免旧流写入已切换/重置的全局 store。
    sendAbortRef.current?.abort();
    const abortController = new AbortController();
    sendAbortRef.current = abortController;

    try {
      const thinkingFields = preferenceToFields(selectedThinkingPreference);
      const recordingIds = recordings.map((r) => r.sessionId);
      const attachmentIds = attachments.map((a) => a.id);

      const res = await fetch('/api/llm/chat', {
        method: 'POST',
        signal: abortController.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          conversationId,
          question: questionText,
          // U12 会让这两个字段真正生效；当前端点会忽略未识别的字段
          recordingIds,
          attachmentIds,
          // 兼容：当前端点仍要求 transcript / summaryContext，这里给空
          transcript: [],
          summaryContext: '',
          totalTranscriptMs: 0,
          model: selectedModel || undefined,
          ...(imagesToSend.length > 0 ? { images: imagesToSend } : {}),
          ...(thinkingFields.thinkingDepth !== undefined
            ? { thinkingDepth: thinkingFields.thinkingDepth }
            : {}),
          ...(thinkingFields.thinkingEnabled !== undefined
            ? { thinkingEnabled: thinkingFields.thinkingEnabled }
            : {}),
        }),
      });

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
        } else if (event === 'error') {
          sawError = true;
          // 上下文已满（EOL）：置位标志，禁用输入并引导新建对话。
          if (payload.contextFull === true) setContextFull(conversationId, true);
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

      if (!sawError) {
        updateMessage(conversationId, assistantId, { streaming: false });
        // 首轮对话完成 → 异步生成标题；完成后强刷共享会话列表，
        // 侧栏/首页的「未命名对话」即时换成真实标题。
        if (isFirstExchange && token) {
          void fetch(
            `/api/conversations/${encodeURIComponent(conversationId)}/generate-title`,
            { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
          )
            .then(() =>
              useConversationListStore
                .getState()
                .refresh(token, { force: true })
            )
            .catch(() => undefined);
        }
      }
    } catch (error) {
      // 流被 abort（切换对话/卸载/点「停止」）—— 静默收尾，不写错误气泡。
      // U18：必须先清掉占位消息的 streaming 标志再 return，否则该气泡的旋转 loader 与
      // 「思考中…」占位会永久卡住（直到刷新/切换对话）。
      if ((error as { name?: string })?.name === 'AbortError') {
        updateMessage(conversationId, assistantId, { streaming: false });
        return;
      }
      updateMessage(conversationId, assistantId, {
        content: `Error: ${error instanceof Error ? error.message : 'Chat failed'}`,
        streaming: false,
      });
    } finally {
      setLoading(conversationId, false);
    }
  };

  /* ──────────────────────────────────────────────────────────────
     切模型时收敛 thinking 偏好 —— 与 ChatTab 同步
     ────────────────────────────────────────────────────────────── */
  const handleSelectModel = (modelName: string) => {
    const model = availableModels.find((m) => m.name === modelName);
    setSelectedModel(modelName);
    if (model) {
      const validPrefs = thinkingOptionsForMode(model.thinkingMode)
        .filter((opt) => !opt.disabled)
        .map((opt) => opt.pref);
      if (model.thinkingMode === 'NONE') {
        setSelectedThinkingPreference('auto');
      } else if (!validPrefs.includes(selectedThinkingPreference)) {
        setSelectedThinkingPreference(
          model.thinkingMode === 'DEPTH' ? 'medium' : 'auto'
        );
      }
    }
    setShowModelMenu(false);
  };

  const thinkingDisabled = currentThinkingMode === 'NONE';
  const thinkingOptions = thinkingOptionsForMode(currentThinkingMode);
  const isThinkingActive =
    !thinkingDisabled && selectedThinkingPreference !== 'off';
  const thinkingLabel = (() => {
    switch (selectedThinkingPreference) {
      case 'off':
        return '不思考';
      case 'low':
        return '低思考';
      case 'medium':
        return '中思考';
      case 'high':
        return '高思考';
      case 'forced':
        return '强制思考';
      case 'auto':
        return '自动思考';
    }
  })();

  return (
    <div className="flex flex-col h-full bg-white">
      {/* 顶部录音 bar */}
      <RecordingsBar
        recordings={recordings}
        attachDisabled={!recordingsReady || isEnded}
        onAttach={() => {
          if (!recordingsReady) {
            toast.info(t('chat.recordingPickerComingSoon'));
            return;
          }
          if (isEnded) {
            toast.info(t('chat.endedReadonly'));
            return;
          }
          setPickerOpen(true);
        }}
        onDetach={recordingsReady && !isEnded ? handleDetachRecording : undefined}
      />

      <RecordingPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        conversationId={conversationId}
        alreadyAttached={recordings.map((r) => r.sessionId)}
        onAttached={() => {
          void reloadRecordings();
        }}
      />

      {/* Messages —— Claude 式居中窄栏 */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto w-full px-4 lg:px-6 py-5 space-y-5">
          {/* U19：主动压缩后被折叠的早期消息 —— 用户可展开查看原文（与 ChatTab 一致） */}
          {archivedMessages.length > 0 && (
            <div className="border border-cream-200 rounded-md bg-cream-50/30">
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                className="w-full flex items-center justify-between px-2.5 py-1.5
                           text-[11px] text-charcoal-500 hover:bg-cream-100/50 transition-colors"
              >
                <span>
                  {showArchived
                    ? t('chat.hideCollapsed', { count: archivedMessages.length })
                    : t('chat.showCollapsed', { count: archivedMessages.length })}
                </span>
                {showArchived ? (
                  <ChevronUp className="w-3 h-3" />
                ) : (
                  <ChevronDown className="w-3 h-3" />
                )}
              </button>
              {showArchived && (
                <div className="border-t border-cream-200 px-2 py-2 space-y-2 opacity-80">
                  {archivedMessages.map((msg) => (
                    <MessageBubble key={msg.id} msg={msg} />
                  ))}
                </div>
              )}
            </div>
          )}

          {messages.length === 0 && archivedMessages.length === 0 && (
            <div className="text-center py-16 text-charcoal-300 animate-fade-in-up">
              <Bot className="w-9 h-9 mx-auto mb-3 opacity-50 animate-breathe" />
              <p className="text-sm">{t('chat.composerPlaceholder')}</p>
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} />
          ))}
          <div ref={scrollRef} />
        </div>
      </div>

      {/* Input area —— Claude 式 composer 卡片（居中窄栏） */}
      <div className="px-4 lg:px-6 pb-4 pt-1 sticky bottom-0 bg-white safe-bottom">
        <div className="max-w-3xl mx-auto w-full">
        {isEnded && !contextFull && (
          <div className="mb-2 px-2.5 py-1.5 rounded-md bg-charcoal-50 border border-charcoal-200 text-[11px] text-charcoal-600 flex items-center justify-between">
            <span>{t('chat.endedReadonly')}</span>
            <button
              type="button"
              onClick={() => void handleNewConversation()}
              className="ml-2 px-2 py-0.5 rounded bg-rust-500 text-white hover:bg-rust-600 transition-colors flex-shrink-0"
            >
              {t('chat.newConversation')}
            </button>
          </div>
        )}
        {contextFull && (
          <div className="mb-2 px-2.5 py-1.5 rounded-md bg-red-50 border border-red-200 text-[11px] text-red-700 flex items-center justify-between">
            <span>上下文已满，所有降级策略均无法塞下。</span>
            <button
              type="button"
              onClick={() => void handleNewConversation()}
              className="ml-2 px-2 py-0.5 rounded bg-red-600 text-white hover:bg-red-700 transition-colors flex-shrink-0"
            >
              新建对话
            </button>
          </div>
        )}
        {imageError && (
          <div className="mb-1.5 px-2 py-1 rounded-md bg-amber-50 text-[10px] text-amber-700 border border-amber-200">
            {imageError}
          </div>
        )}

        {/* Composer 卡片：附件 chips + 图片缩略图 + 文本框 + 工具行 */}
        <div
          className="rounded-2xl border border-cream-300 bg-white shadow-sm
                     focus-within:border-rust-400 focus-within:ring-1 focus-within:ring-rust-400
                     px-3 pt-2.5 pb-2 transition-colors"
        >
        {/* 已上传文件附件 chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {attachments.map((a) => (
              <AttachmentChip
                key={a.id}
                attachment={a}
                onRemove={removeAttachment}
              />
            ))}
          </div>
        )}

        {/* 已选图片缩略图（在输入框上方） */}
        {pendingImages.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {pendingImages.map((url, i) => (
              <div
                key={i}
                className="relative w-14 h-14 rounded-md overflow-hidden border border-cream-300"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={`附件 ${i + 1}`}
                  className="w-full h-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => removePendingImage(i)}
                  className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-charcoal-800/80
                             text-white flex items-center justify-center hover:bg-charcoal-900"
                  title="移除图片"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <input
          ref={imageInputRef}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES.join(',')}
          multiple
          onChange={handleImagePick}
          className="hidden"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_FILE_INPUT_STRING}
          onChange={handleFilePick}
          className="hidden"
        />

        {/* 文本框（无边框，卡片本身是输入区边界） */}
          <textarea
            ref={composerRef}
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
            }}
            onKeyDown={(e) => {
              // 回车发送；Shift+Enter 换行；IME 合成中的回车不发送
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !composing &&
                !e.nativeEvent.isComposing &&
                // U79：Safari 在 compositionend 之后才派发确认候选词的 keydown，此时上面两道
                // 守卫都已失效；用时间窗口把紧随 compositionend（<50ms）的 Enter 视为合成确认，
                // 不当发送。Chrome 里 isComposing 仍为 true，本就走不到这里，不受影响。
                // keyCode 229 是部分浏览器对 IME 进行中 keydown 的标记，一并挡掉。
                e.nativeEvent.keyCode !== 229 &&
                Date.now() - lastCompositionEndRef.current > 50
              ) {
                e.preventDefault();
                void handleSend();
              }
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => {
              setComposing(false);
              lastCompositionEndRef.current = Date.now();
            }}
            onPaste={handlePaste}
            placeholder={
              isEnded ? t('chat.endedReadonly') : t('chat.composerPlaceholder')
            }
            className="w-full px-1 py-1 bg-transparent text-sm resize-none
                       max-h-32 overflow-y-auto
                       focus:outline-none
                       text-charcoal-700 placeholder:text-charcoal-300
                       disabled:cursor-not-allowed"
            disabled={isLoading || contextFull || isEnded}
          />

        {/* 工具行：图片/文件（左） —— 模型 · 思考 · 发送（右） */}
        <div className="flex items-center justify-between mt-1">
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => imageInputRef.current?.click()}
              disabled={isLoading || !supportsImage || isEnded}
              title={supportsImage ? '上传图片' : '当前模型不支持图片输入'}
              className="w-8 h-8 rounded-lg text-charcoal-400
                         hover:bg-cream-100 hover:text-charcoal-600 transition-colors
                         flex items-center justify-center
                         disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
            >
              <ImagePlus className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading || uploadingFile || isEnded}
              title={t('chat.attachFile')}
              className="w-8 h-8 rounded-lg text-charcoal-400
                         hover:bg-cream-100 hover:text-charcoal-600 transition-colors
                         flex items-center justify-center
                         disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
            >
              {uploadingFile ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Paperclip className="w-4 h-4" />
              )}
            </button>
          </div>

          <div className="flex items-center gap-1.5 text-[11px] min-w-0">
            <div ref={modelMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setShowModelMenu((v) => !v)}
                title={`模型: ${currentModelLabel}`}
                className="font-medium text-rust-600 hover:text-rust-700 transition-colors
                           truncate max-w-[120px]"
              >
                {currentModelLabel}
              </button>
              {showModelMenu && (
                <div className="absolute bottom-full right-0 mb-2 w-56 bg-white border border-cream-300
                                rounded-lg shadow-lg z-50 py-1 animate-fade-in-scale">
                  {availableModels.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-charcoal-400">
                      暂无可用模型
                    </div>
                  ) : (
                    availableModels.map((model) => {
                      const modeLabel =
                        model.thinkingMode === 'FORCED'
                          ? '自带深度思考'
                          : model.thinkingMode === 'DEPTH'
                            ? '可调节深度思考'
                            : model.thinkingMode === 'AUTO'
                              ? '自决思考'
                              : '标准模式';
                      const imageLabel = model.supportsImage ? '· 文字+图片' : '';
                      return (
                        <button
                          key={model.name}
                          onClick={() => handleSelectModel(model.name)}
                          className={`w-full text-left px-3 py-2 text-xs hover:bg-cream-50 transition-colors
                            ${selectedModel === model.name ? 'text-rust-600 bg-rust-50' : 'text-charcoal-600'}`}
                        >
                          <div className="font-medium">{model.displayName}</div>
                          <div className="text-[10px] text-charcoal-400 mt-0.5">
                            {modeLabel} {imageLabel}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            <span className="text-charcoal-300">·</span>

            <div ref={thinkingMenuRef} className="relative">
              <button
                type="button"
                onClick={() => {
                  if (thinkingDisabled) return;
                  setShowThinkingMenu((v) => !v);
                }}
                title={
                  thinkingDisabled ? '该模型不支持思考' : `思考: ${thinkingLabel}`
                }
                className={`font-medium transition-colors ${
                  thinkingDisabled
                    ? 'text-charcoal-300 cursor-not-allowed'
                    : isThinkingActive
                      ? 'text-purple-500 hover:text-purple-600'
                      : 'text-charcoal-400 hover:text-charcoal-600'
                }`}
              >
                {thinkingDisabled ? '不支持思考' : thinkingLabel}
              </button>

              {showThinkingMenu && !thinkingDisabled && (
                <div className="absolute bottom-full right-0 mb-2 w-44 bg-white border border-cream-300
                                rounded-lg shadow-lg z-50 py-1 animate-fade-in-scale">
                  {thinkingOptions.map((opt) => {
                    const isSelected = selectedThinkingPreference === opt.pref;
                    return (
                      <button
                        key={opt.pref}
                        type="button"
                        disabled={opt.disabled}
                        onClick={() => {
                          if (opt.disabled) return;
                          setSelectedThinkingPreference(opt.pref);
                          setShowThinkingMenu(false);
                        }}
                        title={opt.disabledTitle ?? opt.description}
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors
                          ${
                            opt.disabled
                              ? 'text-charcoal-300 cursor-not-allowed'
                              : isSelected
                                ? 'bg-purple-50 text-purple-700'
                                : 'text-charcoal-600 hover:bg-cream-50'
                          }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{opt.label}</span>
                          {isSelected && <Check className="w-3 h-3" />}
                        </div>
                        <div className="text-[10px] text-charcoal-400 mt-0.5">
                          {opt.description}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {isLoading ? (
              <button
                type="button"
                onClick={() => {
                  sendAbortRef.current?.abort();
                  setLoading(conversationId, false);
                }}
                title={t('chat.stop')}
                aria-label={t('chat.stop')}
                className="w-8 h-8 rounded-lg bg-charcoal-200 text-charcoal-600 hover:bg-charcoal-300
                           flex items-center justify-center transition-colors flex-shrink-0"
              >
                <Square className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={
                  contextFull ||
                  isEnded ||
                  !historyLoaded ||
                  uploadingFile ||
                  (!input.trim() && pendingImages.length === 0)
                }
                aria-label={t('chat.send')}
                title={t('chat.send')}
                className="w-8 h-8 rounded-lg bg-rust-500 text-white hover:bg-rust-600
                           flex items-center justify-center
                           disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
              >
                <ArrowUp className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
        </div>
        </div>
      </div>
    </div>
  );
}
