'use client';

import { useState, useRef, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useExitAnimation } from '@/hooks/useExitAnimation';
import { useChat } from '@/hooks/useChat';
import { useKeywords } from '@/hooks/useKeywords';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useSummaryStore } from '@/stores/summaryStore';
import type { ThinkingPreference } from '@/stores/chatStore';
import {
  Send,
  Loader2,
  User,
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Sparkles,
  CheckCircle2,
  XCircle,
  MessageSquarePlus,
  Check,
  ImagePlus,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { ChatMessage, ThinkingMode } from '@/types/llm';

/* ------------------------------------------------------------------ */
/*  图片上传约束（与服务端 LLM_LIMITS 对齐）                              */
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

/** 把 File 读成 base64 data URL */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

interface ChatContextSegment {
  text: string;
}

interface ChatContextSummary {
  summary?: string;
}

/* ------------------------------------------------------------------ */
/*  Thinking 偏好 → 显示元数据                                          */
/* ------------------------------------------------------------------ */

/** 按模型 thinkingMode 计算 popover 选项集 */
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
  // FORCED
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
/*  Markdown 渲染（统一样式）                                             */
/* ------------------------------------------------------------------ */

/** 过滤 markdown 链接 href —— 只放行 http/https/mailto/锚点/相对链接，
 *  丢弃 javascript: / data: 等可执行协议（LLM 输出不可信）。 */
function safeHref(href: unknown): string | undefined {
  if (typeof href !== 'string') return undefined;
  return /^(https?:|mailto:|#|\/)/i.test(href.trim()) ? href : undefined;
}

/** 聊天气泡 & thinking 块共用的 Markdown 渲染器 */
function Md({ children }: { children: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children: c }) => <p className="mb-1.5 last:mb-0">{c}</p>,
        strong: ({ children: c }) => (
          <strong className="font-semibold">{c}</strong>
        ),
        em: ({ children: c }) => <em className="italic">{c}</em>,
        ul: ({ children: c }) => (
          <ul className="list-disc list-inside mb-1.5 space-y-0.5">{c}</ul>
        ),
        ol: ({ children: c }) => (
          <ol className="list-decimal list-inside mb-1.5 space-y-0.5">{c}</ol>
        ),
        li: ({ children: c }) => <li>{c}</li>,
        code: ({ children: c, className: codeClass }) => {
          // 行内 code vs 块级 code — react-markdown 在块级时会包在 <pre> 里
          const isInline = !codeClass;
          return isInline ? (
            <code className="px-1 py-0.5 rounded bg-charcoal-100 text-rust-600 text-[10px] font-mono">
              {c}
            </code>
          ) : (
            <code className={codeClass}>{c}</code>
          );
        },
        pre: ({ children: c }) => (
          <pre className="my-1.5 p-2 rounded-md bg-charcoal-800 text-cream-100 text-[10px] font-mono overflow-x-auto">
            {c}
          </pre>
        ),
        blockquote: ({ children: c }) => (
          <blockquote className="border-l-2 border-rust-300 pl-2 my-1.5 text-charcoal-500 italic">
            {c}
          </blockquote>
        ),
        h1: ({ children: c }) => (
          <h1 className="font-bold text-sm mb-1">{c}</h1>
        ),
        h2: ({ children: c }) => (
          <h2 className="font-bold text-xs mb-1">{c}</h2>
        ),
        h3: ({ children: c }) => (
          <h3 className="font-semibold text-xs mb-0.5">{c}</h3>
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
        // 聊天图片：限制最大尺寸，避免大图撑爆气泡
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
/*  思考过程折叠组件（Claude.ai 风格）                                    */
/* ------------------------------------------------------------------ */

/**
 * 干净的可折叠"思考"块。
 *  - 流式生成中：自动展开，标题显示"思考中…"，让用户实时观看推理。
 *  - 完成后：默认折叠，标题显示"已深度思考 Ns"，点击展开看 markdown 推理。
 * 不再有旧版那种把预览文字塞到标题右侧、换行成两行的拥挤布局。
 */
function ThinkingBlock({
  thinking,
  streaming,
  thinkingMs,
}: {
  thinking: string;
  streaming?: boolean;
  thinkingMs?: number;
}) {
  // null = 跟随默认（流式中展开、完成后折叠）；boolean = 用户手动选择
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
/*  /keyword 步骤指示器                                                  */
/* ------------------------------------------------------------------ */

interface KeywordStep {
  label: string;
  status: 'pending' | 'active' | 'done' | 'error';
}

function KeywordSteps({ steps }: { steps: KeywordStep[] }) {
  return (
    <div className="flex items-center gap-2 my-1.5 ml-8">
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-1">
          {step.status === 'active' && (
            <Loader2 className="w-3 h-3 text-rust-500 animate-spin" />
          )}
          {step.status === 'done' && (
            <CheckCircle2 className="w-3 h-3 text-green-500" />
          )}
          {step.status === 'error' && (
            <XCircle className="w-3 h-3 text-red-500" />
          )}
          {step.status === 'pending' && (
            <div className="w-3 h-3 rounded-full border border-charcoal-300" />
          )}
          <span
            className={`text-[11px] ${
              step.status === 'active'
                ? 'text-rust-600 font-medium'
                : step.status === 'done'
                  ? 'text-green-600'
                  : step.status === 'error'
                    ? 'text-red-600'
                    : 'text-charcoal-400'
            }`}
          >
            {step.label}
          </span>
          {i < steps.length - 1 && (
            <div className="w-4 h-px bg-charcoal-200 mx-0.5" />
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  上下文小圈 + 详情卡                                                  */
/* ------------------------------------------------------------------ */

function getRingColor(percent: number, contextFull: boolean): { stroke: string; bg: string; text: string } {
  if (contextFull) return { stroke: '#7c3aed', bg: '#ede9fe', text: 'text-purple-600' }; // 紫：RAG/EOL
  if (percent < 0.6) return { stroke: '#059669', bg: '#d1fae5', text: 'text-green-600' };
  if (percent < 0.85) return { stroke: '#d97706', bg: '#fef3c7', text: 'text-amber-600' };
  return { stroke: '#dc2626', bg: '#fee2e2', text: 'text-red-600' };
}

function ContextRingButton({
  percent,
  level,
  contextFull,
  onClick,
}: {
  percent: number;
  level: number;
  contextFull: boolean;
  onClick: () => void;
}) {
  const safePercent = Math.min(1, Math.max(0, percent));
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - safePercent);
  const palette = getRingColor(safePercent, contextFull);
  const displayPercent = Math.round(safePercent * 100);

  return (
    <button
      type="button"
      onClick={onClick}
      title={`上下文 ${displayPercent}% · 降级级别 L${level}`}
      className="relative w-5 h-5 rounded-full flex items-center justify-center
                 hover:bg-cream-100 transition-colors flex-shrink-0"
    >
      <svg viewBox="0 0 24 24" className="w-5 h-5 -rotate-90">
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth="2"
        />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke={palette.stroke}
          strokeWidth="2"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

function ContextPopover({
  leaving,
  tokenUsage,
  level,
  conversations,
  activeConversationId,
  showConversationList,
  onToggleConversationList,
  onNewConversation,
  onSwitchConversation,
  onClose,
}: {
  leaving: boolean;
  tokenUsage: import('@/stores/chatStore').ChatTokenUsage | null;
  level: number;
  conversations: import('@/stores/chatStore').ConversationMeta[];
  activeConversationId: string | null;
  showConversationList: boolean;
  onToggleConversationList: () => void;
  onNewConversation: () => void;
  onSwitchConversation: (id: string) => void;
  onClose: () => void;
}) {
  const used = tokenUsage?.used ?? 0;
  const budget = tokenUsage?.budget ?? 0;
  const percent = budget > 0 ? Math.min(1, used / budget) : 0;
  const breakdown = tokenUsage?.breakdown;

  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const activeTitle =
    activeConv?.title ||
    (activeConv ? `对话 ${formatHM(activeConv.startedAt)} 起` : '当前对话');

  return (
    <div className={`absolute bottom-full right-0 mb-2 w-72 bg-white border border-cream-300
                    rounded-lg shadow-lg z-50 p-3 text-xs ${leaving ? 'animate-fade-out-scale' : 'animate-fade-in-scale'}`}>
      {/* Conversation 选择器（小箭头展开） */}
      <button
        type="button"
        onClick={onToggleConversationList}
        className="w-full flex items-center justify-between px-2 py-1.5 rounded-md
                   hover:bg-cream-50 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <MessageSquarePlus className="w-3 h-3 text-rust-500" />
          <span className="font-medium text-charcoal-700 truncate">{activeTitle}</span>
        </span>
        {showConversationList ? (
          <ChevronUp className="w-3 h-3 text-charcoal-400" />
        ) : (
          <ChevronDown className="w-3 h-3 text-charcoal-400" />
        )}
      </button>

      {showConversationList && (
        <div className="mt-1 mb-2 border border-cream-200 rounded-md max-h-48 overflow-y-auto">
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                onSwitchConversation(c.id);
                onClose();
              }}
              className={`w-full flex items-center justify-between px-2 py-1.5 text-left
                hover:bg-cream-50 transition-colors
                ${c.id === activeConversationId ? 'bg-rust-50' : ''}`}
            >
              <span className="flex flex-col">
                <span className="text-[11px] font-medium text-charcoal-700">
                  {c.title || `对话 ${formatHM(c.startedAt)} 起`}
                  {c.endedAt && (
                    <span className="ml-1 text-charcoal-400">（已关闭）</span>
                  )}
                </span>
                <span className="text-[10px] text-charcoal-400">
                  {c.messageCount} 条 · L{c.degradationLevel}
                </span>
              </span>
              {c.id === activeConversationId && (
                <Check className="w-3 h-3 text-rust-500" />
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              onNewConversation();
              onClose();
            }}
            className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left
                       text-rust-600 hover:bg-rust-50 transition-colors border-t border-cream-200"
          >
            <MessageSquarePlus className="w-3 h-3" />
            <span className="text-[11px] font-medium">新建对话</span>
          </button>
        </div>
      )}

      <div className="h-px bg-cream-200 my-2" />

      {/* 上下文用量 */}
      <div className="mb-1">
        <div className="flex items-center justify-between mb-1">
          <span className="text-charcoal-500">上下文用量</span>
          <span className="font-mono text-charcoal-700">
            {Math.round(percent * 100)}% · L{level}
          </span>
        </div>
        <div className="h-1.5 bg-cream-200 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${percent * 100}%`,
              backgroundColor: getRingColor(percent, false).stroke,
            }}
          />
        </div>
        <div className="text-[10px] text-charcoal-400 mt-1 text-right">
          {(used / 1000).toFixed(1)}K / {(budget / 1000).toFixed(1)}K tokens
        </div>
      </div>

      {breakdown && (
        <div className="space-y-0.5 text-[10px] mt-2">
          <BreakdownRow label="系统提示" value={breakdown.systemPrompt} />
          <BreakdownRow label="Transcript" value={breakdown.transcript} />
          <BreakdownRow label="Summary" value={breakdown.summary} />
          <BreakdownRow label="历史对话" value={breakdown.history} />
          <BreakdownRow label="当前输入" value={breakdown.userInput} />
        </div>
      )}

      <div className="mt-2 pt-2 border-t border-cream-200 text-[10px] text-charcoal-400">
        输入 <code className="bg-cream-100 px-1 rounded">/compress</code> 主动压缩历史
      </div>
    </div>
  );
}

function BreakdownRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between text-charcoal-500">
      <span>{label}</span>
      <span className="font-mono">{value > 1000 ? `${(value / 1000).toFixed(1)}K` : value}</span>
    </div>
  );
}

function formatHM(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  } catch {
    return iso;
  }
}

/* ------------------------------------------------------------------ */
/*  消息气泡（含 thinking 折叠）                                         */
/* ------------------------------------------------------------------ */

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'user') {
    return (
      <div className="flex gap-2 justify-end animate-chat-bubble-right">
        <div className="max-w-[80%]">
          {/* Markdown 渲染：用户消息可能内嵌图片引用（![](url)） */}
          <div className="px-3 py-2 rounded-lg text-xs leading-relaxed bg-charcoal-800 text-white chat-user-bubble">
            <Md>{msg.content}</Md>
          </div>
        </div>
        <div className="w-6 h-6 rounded-full bg-charcoal-200 flex items-center justify-center flex-shrink-0">
          <User className="w-3.5 h-3.5 text-charcoal-600" />
        </div>
      </div>
    );
  }

  // 流式中且正文尚空：显示一个轻量"正在生成"占位（思考块若有则已先渲染）
  const showStreamingPlaceholder = msg.streaming && !msg.content;

  return (
    <div className="flex gap-2 animate-chat-bubble-left">
      <div className="w-6 h-6 rounded-full bg-rust-100 flex items-center justify-center flex-shrink-0">
        {msg.streaming ? (
          <Loader2 className="w-3.5 h-3.5 text-rust-600 animate-spin" />
        ) : (
          <Bot className="w-3.5 h-3.5 text-rust-600" />
        )}
      </div>
      <div className="max-w-[80%] min-w-0">
        {/* Thinking 折叠块（放在正文前面）—— 流式时自动展开。
            thinking 一旦收到首个增量就有值（可能为空字符串）。 */}
        {msg.thinking !== undefined && (
          <ThinkingBlock
            thinking={msg.thinking}
            streaming={msg.streaming}
            thinkingMs={msg.thinkingMs}
          />
        )}
        {/* 流式中、还没有任何 thinking/text 增量时的占位 */}
        {showStreamingPlaceholder && msg.thinking === undefined && (
          <div className="flex items-center gap-1.5 text-[11px] text-charcoal-400 mb-1">
            <Sparkles className="w-3 h-3 text-purple-400 animate-breathe" />
            <span>思考中…</span>
          </div>
        )}
        {/* 正文内容（Markdown 渲染）—— 流式中正文为空则暂不渲染气泡 */}
        {msg.content && (
          <div className="px-3 py-2 rounded-lg text-xs leading-relaxed bg-cream-100 text-charcoal-700">
            <Md>{msg.content}</Md>
          </div>
        )}
        {/* 模型 & depth 标签（流式结束后） */}
        {msg.model && !msg.streaming && (
          <div className="flex items-center gap-1.5 mt-0.5 pl-1">
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
    </div>
  );
}

export default function ChatTab({
  onInjectKeywords,
  transcriptSegments,
  summaryBlocks,
  inputSticky = false,
}: {
  onInjectKeywords?: (keywords: string[]) => Promise<void> | void;
  transcriptSegments?: ChatContextSegment[];
  summaryBlocks?: ChatContextSummary[];
  inputSticky?: boolean;
}) {
  const routeParams = useParams<{ id?: string }>();
  const sessionId = routeParams?.id ?? null;

  const {
    messages,
    archivedMessages,
    isLoading,
    selectedModel,
    selectedThinkingPreference,
    availableModels,
    activeConversationId,
    conversations,
    tokenUsage,
    contextFull,
    sendMessage,
    setSelectedModel,
    setSelectedThinkingPreference,
    createNewConversation,
    switchConversation,
    compressActive,
    addMessage,
  } = useChat(sessionId);
  const { extractFromText, addManualKeyword } = useKeywords();

  const [input, setInput] = useState('');
  /** IME 合成中（中文/日文输入法）—— 合成期间回车不应发送 */
  const [composing, setComposing] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showThinkingMenu, setShowThinkingMenu] = useState(false);
  const [showContextPopover, setShowContextPopover] = useState(false);
  const [showConversationList, setShowConversationList] = useState(false);

  // 三个锚定 popover 的进/出场动画（小淡出，150ms）
  const modelMenuAnim = useExitAnimation(showModelMenu, 150);
  const thinkingMenuAnim = useExitAnimation(showThinkingMenu, 150);
  const contextPopoverAnim = useExitAnimation(showContextPopover, 150);
  const [keywordSteps, setKeywordSteps] = useState<KeywordStep[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  /** 已选待发送的图片（base64 data URL 数组） */
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);
  const contextPopoverRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const segments = useTranscriptStore((s) => s.segments);
  const totalDurationMs = useTranscriptStore((s) => s.totalDurationMs);
  const blocks = useSummaryStore((s) => s.blocks);
  const effectiveSegments = transcriptSegments ?? segments;
  const effectiveBlocks = summaryBlocks ?? blocks;

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Close model menu on outside click
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

  // Close thinking menu on outside click
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

  // Close context popover on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        contextPopoverRef.current &&
        !contextPopoverRef.current.contains(e.target as Node)
      ) {
        setShowContextPopover(false);
        setShowConversationList(false);
      }
    };
    if (showContextPopover) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [showContextPopover]);

  const handleSend = async () => {
    const value = input.trim();
    const hasImages = pendingImages.length > 0;
    // 允许"仅图片"发送：有文字或有图片即可
    if ((!value && !hasImages) || isLoading) return;

    setInput('');
    if (composerRef.current) composerRef.current.style.height = 'auto';

    // /compress 命令：触发主动压缩，不发给 LLM
    if (value === '/compress' || value.startsWith('/compress ')) {
      const argMatch = value.slice('/compress'.length).trim();
      const keepTurns = /^\d+$/.test(argMatch)
        ? Math.max(1, Math.min(10, parseInt(argMatch, 10)))
        : 3;

      addMessage({
        id: crypto.randomUUID(),
        role: 'user',
        content: value,
        timestamp: Date.now(),
      });
      const result = await compressActive(keepTurns);
      addMessage({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result.ok
          ? `已压缩对话历史，保留最近 ${keepTurns} 轮原文。早期消息已折叠（点击"已折叠"展开）。`
          : `压缩失败：${result.reason ?? '未知原因'}。建议新建对话继续。`,
        timestamp: Date.now(),
      });
      return;
    }

    if (value.startsWith('/keyword')) {
      addMessage({
        id: crypto.randomUUID(),
        role: 'user',
        content: value,
        timestamp: Date.now(),
      });

      const manualKeywordInput = value.slice('/keyword'.length).trim();

      /* ── 手动添加：/keyword term1, term2 ── */
      if (manualKeywordInput) {
        const steps: KeywordStep[] = [
          { label: '解析关键词', status: 'active' },
          { label: '注入 ASR', status: 'pending' },
        ];
        setKeywordSteps([...steps]);

        const manualKeywords = manualKeywordInput
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);

        if (manualKeywords.length === 0) {
          steps[0].status = 'error';
          setKeywordSteps([...steps]);
          addMessage({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '未找到有效关键词。请尝试 `/keyword term1, term2`。',
            thinking: `解析输入: "${manualKeywordInput}"\n结果: 空（逗号分隔后无有效项）`,
            timestamp: Date.now(),
          });
          setKeywordSteps(null);
          return;
        }

        steps[0].status = 'done';
        steps[1].status = 'active';
        setKeywordSteps([...steps]);

        try {
          manualKeywords.forEach(addManualKeyword);
          if (onInjectKeywords) {
            await onInjectKeywords(manualKeywords);
          }
          steps[1].status = 'done';
          setKeywordSteps([...steps]);
        } catch (error) {
          steps[1].status = 'error';
          setKeywordSteps([...steps]);
          addMessage({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `注入关键词失败: ${error instanceof Error ? error.message : '未知错误'}`,
            thinking: `手动关键词: ${manualKeywords.join(', ')}\n注入阶段出错: ${error instanceof Error ? error.message : String(error)}`,
            timestamp: Date.now(),
          });
          setKeywordSteps(null);
          return;
        }

        addMessage({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `已将 ${manualKeywords.length} 个关键词添加到 ASR 上下文: ${manualKeywords.join(', ')}`,
          thinking: `解析输入: "${manualKeywordInput}"\n识别到 ${manualKeywords.length} 个关键词: [${manualKeywords.join(', ')}]\n已添加到关键词库并注入 ASR 引擎`,
          timestamp: Date.now(),
        });
        setKeywordSteps(null);
        return;
      }

      /* ── 自动提取：/keyword（无参数） ── */
      const steps: KeywordStep[] = [
        { label: '收集转录稿', status: 'active' },
        { label: 'LLM 提取', status: 'pending' },
        { label: '完成', status: 'pending' },
      ];
      setKeywordSteps([...steps]);

      const recentTranscriptForKeywords = effectiveSegments
        .slice(-60)
        .map((segment) => segment.text)
        .join(' ');

      if (!recentTranscriptForKeywords.trim()) {
        steps[0].status = 'error';
        setKeywordSteps([...steps]);
        addMessage({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '转录稿内容不足，无法提取关键词。',
          thinking: `尝试收集最近 60 个片段\n结果: 转录稿为空，跳过 LLM 调用`,
          timestamp: Date.now(),
        });
        setKeywordSteps(null);
        return;
      }

      steps[0].status = 'done';
      steps[1].status = 'active';
      setKeywordSteps([...steps]);

      try {
        const extractedKeywords = await extractFromText(recentTranscriptForKeywords);

        steps[1].status = 'done';
        steps[2].status = 'done';
        setKeywordSteps([...steps]);

        const segmentCount = Math.min(effectiveSegments.length, 60);
        const charCount = recentTranscriptForKeywords.length;

        addMessage({
          id: crypto.randomUUID(),
          role: 'assistant',
          content:
            extractedKeywords.length > 0
              ? `提取到 ${extractedKeywords.length} 个关键词。请在关键词标签页审核，点击 Inject 注入 ASR 上下文。`
              : '当前转录稿中未提取到新关键词。',
          thinking: [
            `收集最近 ${segmentCount} 个转录片段（共 ${charCount} 字符）`,
            `发送至 /api/llm/extract-keywords（截断至 8000 字符）`,
            `LLM 返回 ${extractedKeywords.length} 个关键词`,
            extractedKeywords.length > 0
              ? `结果: [${extractedKeywords.join(', ')}]`
              : '结果: 无新关键词（可能与现有关键词重复）',
          ].join('\n'),
          timestamp: Date.now(),
        });
      } catch (error) {
        steps[1].status = 'error';
        setKeywordSteps([...steps]);

        addMessage({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `关键词提取失败: ${error instanceof Error ? error.message : '未知错误'}`,
          thinking: `收集转录稿: ${recentTranscriptForKeywords.length} 字符\nLLM 调用失败: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: Date.now(),
        });
      }

      setKeywordSteps(null);
      return;
    }

    // 给 chatContextBuilder 传 segments + startMs，让降级链能按"轮窗口"裁剪 transcript。
    // effectiveSegments 既可能来自 props（ChatContextSegment 只有 text），
    // 也可能来自 transcriptStore（TranscriptSegment 含 globalStartMs/startMs）。
    const transcriptSegmentsForApi = effectiveSegments.map((seg) => {
      const s = seg as { text?: string; globalStartMs?: number; startMs?: number };
      return {
        text: s.text ?? '',
        startMs:
          typeof s.globalStartMs === 'number'
            ? s.globalStartMs
            : typeof s.startMs === 'number'
              ? s.startMs
              : 0,
      };
    });

    const summaryContext = effectiveBlocks
      .map((b) => b.summary)
      .filter(Boolean)
      .join('\n');

    // 仅图片时给一个最小占位文本，满足服务端 question 必填校验
    const questionText = value || (hasImages ? '请看图片。' : value);
    const imagesToSend = pendingImages;
    setPendingImages([]);
    setImageError(null);
    sendMessage(
      questionText,
      transcriptSegmentsForApi,
      summaryContext,
      totalDurationMs,
      imagesToSend
    );
  };

  // Current model display info
  const currentModelInfo = availableModels.find((m) => m.name === selectedModel);
  const currentModelLabel = currentModelInfo?.displayName || selectedModel || 'Default';
  const currentThinkingMode: ThinkingMode = currentModelInfo?.thinkingMode ?? 'NONE';

  // 切模型时：保留 user current preference 如果新模型支持；否则收敛到 'medium'（DEPTH）/'auto'（AUTO/FORCED）
  const handleSelectModel = (modelName: string) => {
    const model = availableModels.find((m) => m.name === modelName);
    setSelectedModel(modelName);
    if (model) {
      const validPrefs = thinkingOptionsForMode(model.thinkingMode)
        .filter((opt) => !opt.disabled)
        .map((opt) => opt.pref);
      if (model.thinkingMode === 'NONE') {
        // NONE 模式下随便存什么都行，UI 会禁用按钮；保留 auto 不至于下次切回 DEPTH 时残留奇怪值
        setSelectedThinkingPreference('auto');
      } else if (!validPrefs.includes(selectedThinkingPreference)) {
        // 当前 preference 在新模型上没意义，回落：DEPTH→medium、其他→auto
        setSelectedThinkingPreference(
          model.thinkingMode === 'DEPTH' ? 'medium' : 'auto'
        );
      }
    }
    setShowModelMenu(false);
  };

  // 思考按钮：NONE 模式整体置灰、不可点击
  const thinkingDisabled = currentThinkingMode === 'NONE';
  const thinkingOptions = thinkingOptionsForMode(currentThinkingMode);
  const isThinkingActive =
    !thinkingDisabled && selectedThinkingPreference !== 'off';

  // 当前 thinking 偏好的紧凑中文名（用于 input footer 彩色文字）
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

  /* ── 图片上传：选择 / 粘贴 / 删除 ── */
  const supportsImage = Boolean(currentModelInfo?.supportsImage);

  // 把一批 File 校验后追加进 pendingImages
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
    // 允许重复选择同一文件
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

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {/* 主动压缩后被折叠的早期消息 —— 用户可展开查看原文 */}
        {archivedMessages.length > 0 && (
          <div className="border border-cream-200 rounded-md bg-cream-50/30">
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className="w-full flex items-center justify-between px-2.5 py-1.5
                         text-[11px] text-charcoal-500 hover:bg-cream-100/50 transition-colors"
            >
              <span>
                {showArchived ? '收起' : '展开'} {archivedMessages.length} 条已折叠消息
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
          <div className="text-center py-8 text-charcoal-300 animate-fade-in-up">
            <Bot className="w-8 h-8 mx-auto mb-2 opacity-50 animate-breathe" />
            <p className="text-xs">Ask questions about the lecture</p>
            <p className="text-[11px] mt-1 text-charcoal-400">
              Try: &quot;Explain the main concept&quot; or /keyword
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}

        {/* /keyword 步骤指示器 */}
        {keywordSteps && <KeywordSteps steps={keywordSteps} />}

        {/* 普通对话的 loading 反馈现在由流式 assistant 占位消息承担
            （MessageBubble 在 streaming 态显示思考/正文实时流入），
            不再需要独立的 spinner 块。 */}

        <div ref={scrollRef} />
      </div>

      {/* Input area —— padding 收紧，与顶部 tab bar 视觉对称 */}
      <div className={`border-t border-cream-200 px-3 pt-1.5 pb-0 ${inputSticky ? 'sticky bottom-0 bg-white safe-bottom' : ''}`.trim()}>
        {contextFull && (
          <div className="mb-2 px-2.5 py-1.5 rounded-md bg-red-50 border border-red-200 text-[11px] text-red-700 flex items-center justify-between">
            <span>上下文已满，所有降级策略均无法塞下。</span>
            <button
              type="button"
              onClick={() => createNewConversation()}
              className="ml-2 px-2 py-0.5 rounded bg-red-600 text-white hover:bg-red-700 transition-colors"
            >
              新建对话
            </button>
          </div>
        )}
        {input === '/' && (
          <div className="mb-1.5 px-2 py-1 rounded-md bg-cream-50 text-[10px] text-charcoal-400 border border-cream-200">
            <code className="text-rust-500">/compress</code> 压缩对话历史 ·{' '}
            <code className="text-rust-500">/keyword</code> 提取关键词
          </div>
        )}
        {imageError && (
          <div className="mb-1.5 px-2 py-1 rounded-md bg-amber-50 text-[10px] text-amber-700 border border-amber-200">
            {imageError}
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

        {/* 输入行：附件按钮 + 文本框 + 发送 */}
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            multiple
            onChange={handleImagePick}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading || !supportsImage}
            title={
              supportsImage
                ? '上传图片'
                : '当前模型不支持图片输入'
            }
            className="w-9 h-9 rounded-lg border border-cream-300 bg-white text-charcoal-500
                       hover:border-cream-400 transition-colors flex items-center justify-center
                       disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          >
            <ImagePlus className="w-4 h-4" />
          </button>

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
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void handleSend();
              }
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onPaste={handlePaste}
            placeholder="Ask about the lecture..."
            className="flex-1 px-3 py-2 rounded-lg border border-cream-300 text-xs resize-none
                       max-h-32 overflow-y-auto
                       focus:outline-none focus:ring-1 focus:ring-rust-400 focus:border-rust-400
                       bg-white text-charcoal-700 placeholder:text-charcoal-300"
            disabled={isLoading}
          />
          <button
            onClick={handleSend}
            disabled={isLoading || (!input.trim() && pendingImages.length === 0)}
            className="p-2 rounded-lg bg-rust-500 text-white hover:bg-rust-600
                       disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Footer 行（Claude Code 风格）：模型 · 思考强度 · 上下文小圈，全部右下角 */}
        <div className="flex items-center justify-end gap-1.5 mt-1.5 mb-1.5 px-0.5">
          <div className="flex items-center gap-1 text-[10px] min-w-0">
            {/* 模型：可点击的彩色文字，触发模型 popover */}
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

              {modelMenuAnim.mounted && (
                <div className={`absolute bottom-full left-0 mb-2 w-56 bg-white border border-cream-300
                                rounded-lg shadow-lg z-50 py-1 ${modelMenuAnim.leaving ? 'animate-fade-out-scale' : 'animate-fade-in-scale'}`}>
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

            {/* 思考强度：可点击的彩色文字，触发思考 popover */}
            <div ref={thinkingMenuRef} className="relative">
              <button
                type="button"
                onClick={() => {
                  if (thinkingDisabled) return;
                  setShowThinkingMenu((v) => !v);
                }}
                title={
                  thinkingDisabled
                    ? '该模型不支持思考'
                    : `思考: ${thinkingLabel}`
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

              {thinkingMenuAnim.mounted && !thinkingDisabled && (
                <div className={`absolute bottom-full left-0 mb-2 w-44 bg-white border border-cream-300
                                rounded-lg shadow-lg z-50 py-1 ${thinkingMenuAnim.leaving ? 'animate-fade-out-scale' : 'animate-fade-in-scale'}`}>
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
                          ${opt.disabled
                            ? 'text-charcoal-300 cursor-not-allowed'
                            : isSelected
                              ? 'bg-purple-50 text-purple-700'
                              : 'text-charcoal-600 hover:bg-cream-50'}`}
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
          </div>

          {/* 右侧：上下文小圈 */}
          <div ref={contextPopoverRef} className="relative flex-shrink-0">
            <ContextRingButton
              percent={
                tokenUsage && tokenUsage.budget > 0
                  ? tokenUsage.used / tokenUsage.budget
                  : 0
              }
              level={tokenUsage?.level ?? 1}
              contextFull={contextFull}
              onClick={() => setShowContextPopover((v) => !v)}
            />
            {contextPopoverAnim.mounted && (
              <ContextPopover
                leaving={contextPopoverAnim.leaving}
                tokenUsage={tokenUsage}
                level={tokenUsage?.level ?? 1}
                conversations={conversations}
                activeConversationId={activeConversationId}
                showConversationList={showConversationList}
                onToggleConversationList={() =>
                  setShowConversationList((v) => !v)
                }
                onNewConversation={createNewConversation}
                onSwitchConversation={switchConversation}
                onClose={() => {
                  setShowContextPopover(false);
                  setShowConversationList(false);
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
