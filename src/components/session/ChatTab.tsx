'use client';

import { useState, useRef, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useChat } from '@/hooks/useChat';
import { useKeywords } from '@/hooks/useKeywords';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useSummaryStore } from '@/stores/summaryStore';
import {
  Send,
  Loader2,
  User,
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Zap,
  Brain,
  Sparkles,
  CheckCircle2,
  XCircle,
  MessageSquarePlus,
  Check,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { ChatMessage, ThinkingDepth } from '@/types/llm';

interface ChatContextSegment {
  text: string;
}

interface ChatContextSummary {
  summary?: string;
}

const DEPTH_OPTIONS: {
  value: ThinkingDepth;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    value: 'low',
    label: 'Quick',
    description: 'Fast, concise answers',
    icon: <Zap className="w-3 h-3" />,
  },
  {
    value: 'medium',
    label: 'Normal',
    description: 'Balanced responses',
    icon: <Brain className="w-3 h-3" />,
  },
  {
    value: 'high',
    label: 'Deep',
    description: 'In-depth analysis with extended thinking',
    icon: <Sparkles className="w-3 h-3" />,
  },
];

/* ------------------------------------------------------------------ */
/*  Markdown 渲染（统一样式）                                             */
/* ------------------------------------------------------------------ */

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
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-rust-500 underline hover:text-rust-700"
          >
            {c}
          </a>
        ),
        hr: () => <hr className="my-2 border-charcoal-200" />,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

/* ------------------------------------------------------------------ */
/*  思考过程折叠组件                                                     */
/* ------------------------------------------------------------------ */

function ThinkingBlock({ thinking }: { thinking: string }) {
  const [expanded, setExpanded] = useState(false);
  // 截断显示前 120 字符作为预览
  const preview =
    thinking.length > 120 ? thinking.slice(0, 120) + '…' : thinking;

  return (
    <div className="mt-1.5 mb-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-purple-500 hover:text-purple-700
                   transition-colors group"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        <Sparkles className="w-3 h-3" />
        <span className="font-medium">思考过程</span>
        {!expanded && (
          <span className="text-charcoal-400 font-normal ml-1 truncate max-w-[200px]">
            {preview}
          </span>
        )}
      </button>
      {expanded && (
        <div
          className="mt-1 ml-4 px-2.5 py-2 rounded-md text-[11px] leading-relaxed
                      bg-purple-50/60 text-purple-800 border border-purple-100
                      max-h-[240px] overflow-y-auto"
        >
          <Md>{thinking}</Md>
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
/*  消息气泡（含 thinking 折叠）                                         */
/* ------------------------------------------------------------------ */

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
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - safePercent);
  const palette = getRingColor(safePercent, contextFull);
  const displayPercent = Math.round(safePercent * 100);
  const showLevel = level > 1;

  return (
    <button
      type="button"
      onClick={onClick}
      title={`上下文 ${displayPercent}% · 降级级别 L${level}`}
      className="relative w-7 h-7 rounded-full flex items-center justify-center
                 hover:bg-cream-100 transition-colors flex-shrink-0"
    >
      <svg viewBox="0 0 24 24" className="w-7 h-7 -rotate-90">
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth="2.5"
        />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke={palette.stroke}
          strokeWidth="2.5"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
        />
      </svg>
      <span
        className={`absolute text-[8px] font-semibold ${palette.text}`}
      >
        {showLevel ? `L${level}` : `${displayPercent}`}
      </span>
    </button>
  );
}

function ContextPopover({
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
    <div className="absolute bottom-full right-0 mb-2 w-72 bg-white border border-cream-300
                    rounded-lg shadow-lg z-50 p-3 text-xs animate-fade-in-scale">
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
          <div className="px-3 py-2 rounded-lg text-xs leading-relaxed bg-charcoal-800 text-white">
            {msg.content}
          </div>
        </div>
        <div className="w-6 h-6 rounded-full bg-charcoal-200 flex items-center justify-center flex-shrink-0">
          <User className="w-3.5 h-3.5 text-charcoal-600" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 animate-chat-bubble-left">
      <div className="w-6 h-6 rounded-full bg-rust-100 flex items-center justify-center flex-shrink-0">
        <Bot className="w-3.5 h-3.5 text-rust-600" />
      </div>
      <div className="max-w-[80%]">
        {/* Thinking 折叠块（放在正文前面） */}
        {msg.thinking && <ThinkingBlock thinking={msg.thinking} />}
        {/* 正文内容（Markdown 渲染） */}
        <div className="px-3 py-2 rounded-lg text-xs leading-relaxed bg-cream-100 text-charcoal-700">
          <Md>{msg.content}</Md>
        </div>
        {/* 模型 & depth 标签 */}
        {msg.model && (
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
            {msg.thinking && (
              <span className="text-[10px] px-1 py-0.5 rounded bg-purple-50 text-purple-400">
                含思考
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
    selectedDepth,
    selectedThinkingEnabled,
    availableModels,
    activeConversationId,
    conversations,
    tokenUsage,
    contextFull,
    sendMessage,
    setSelectedModel,
    setSelectedDepth,
    setSelectedThinkingEnabled,
    createNewConversation,
    switchConversation,
    compressActive,
    addMessage,
  } = useChat(sessionId);
  const { extractFromText, addManualKeyword } = useKeywords();

  const [input, setInput] = useState('');
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showContextPopover, setShowContextPopover] = useState(false);
  const [showConversationList, setShowConversationList] = useState(false);
  const [keywordSteps, setKeywordSteps] = useState<KeywordStep[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const contextPopoverRef = useRef<HTMLDivElement>(null);

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
    if (!value || isLoading) return;

    setInput('');

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

    sendMessage(value, transcriptSegmentsForApi, summaryContext, totalDurationMs);
  };

  // Current model display info
  const currentModelInfo = availableModels.find((m) => m.name === selectedModel);
  const currentModelLabel = currentModelInfo?.displayName || selectedModel || 'Default';

  // 思考能力派生状态：根据当前模型决定 UI 显示哪些控件
  const currentThinkingMode = currentModelInfo?.thinkingMode ?? 'NONE';
  const currentSupportsThinkingDepth = currentModelInfo?.supportsThinkingDepth ?? false;
  // 是否要在 UI 显示「开关思考」按钮（只有 OPTIONAL 才有意义）
  const showThinkingToggle = currentThinkingMode === 'OPTIONAL';
  // 思考是否处于「打开」状态（决定深度选择器是否激活、是否传 thinkingEnabled=true）
  const thinkingActive =
    currentThinkingMode === 'FORCED' ||
    (currentThinkingMode === 'OPTIONAL' && selectedThinkingEnabled);
  // 深度选择器：仅当思考激活 + 模型支持调节时展示
  const showDepthSelector = thinkingActive && currentSupportsThinkingDepth;
  // Allowed depths for current model（来自 /api/llm/models，已经按模型实际能力裁剪）
  const currentAllowedDepths = currentModelInfo?.allowedDepths || ['low', 'medium'];

  return (
    <div className="flex flex-col h-full">
      {/* Model & Depth selector bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-cream-100 bg-cream-50/50">
        {/* Model selector */}
        <div ref={modelMenuRef} className="relative">
          <button
            onClick={() => setShowModelMenu(!showModelMenu)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium
                       border border-cream-300 bg-white text-charcoal-600
                       hover:border-cream-400 transition-colors"
          >
            <Bot className="w-3 h-3 text-rust-500" />
            <span className="max-w-[100px] truncate">{currentModelLabel}</span>
            <ChevronDown className="w-3 h-3 text-charcoal-400" />
          </button>

          {showModelMenu && availableModels.length > 0 && (
            <div className="absolute top-full mt-1 left-0 w-56 bg-white border border-cream-300
                            rounded-lg shadow-lg z-50 py-1 animate-fade-in-scale">
              {availableModels.map((model) => {
                const modeLabel =
                  model.thinkingMode === 'FORCED'
                    ? '自带深度思考'
                    : model.thinkingMode === 'OPTIONAL'
                      ? '可开启深度思考'
                      : '标准模式';
                const imageLabel = model.supportsImage ? '· 文字+图片' : '';
                return (
                  <button
                    key={model.name}
                    onClick={() => {
                      setSelectedModel(model.name);
                      // 切到不支持深度调节的模型时把 selectedDepth 收敛到允许集合内
                      if (!model.allowedDepths.includes(selectedDepth)) {
                        setSelectedDepth(model.allowedDepths[0] ?? 'medium');
                      }
                      // 切到不支持思考的模型时把开关关掉，避免下次切回 OPTIONAL 时残留
                      if (model.thinkingMode === 'NONE') {
                        setSelectedThinkingEnabled(false);
                      }
                      setShowModelMenu(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-cream-50 transition-colors
                      ${selectedModel === model.name ? 'text-rust-600 bg-rust-50' : 'text-charcoal-600'}`}
                  >
                    <div className="font-medium">{model.displayName}</div>
                    <div className="text-[10px] text-charcoal-400 mt-0.5">
                      {modeLabel} {imageLabel}
                    </div>
                  </button>
                );
              })}

              {availableModels.length === 0 && (
                <div className="px-3 py-2 text-xs text-charcoal-400">
                  No models available
                </div>
              )}
            </div>
          )}
        </div>

        {/* 思考开关（仅 OPTIONAL 模型显示） */}
        {showThinkingToggle && (
          <button
            onClick={() => setSelectedThinkingEnabled(!selectedThinkingEnabled)}
            title={selectedThinkingEnabled ? '点击关闭深度思考' : '点击开启深度思考'}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium border transition-colors
              ${
                selectedThinkingEnabled
                  ? 'bg-purple-50 text-purple-600 border-purple-200'
                  : 'bg-white text-charcoal-500 border-cream-300 hover:border-cream-400'
              }`}
          >
            <Sparkles className="w-3 h-3" />
            {selectedThinkingEnabled ? '思考已开' : '思考已关'}
          </button>
        )}

        {/* FORCED 模型显示一个不可关闭的标识 */}
        {currentThinkingMode === 'FORCED' && (
          <span
            title="该模型自带思考，无法关闭"
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium
                       bg-purple-50 text-purple-600 border border-purple-200"
          >
            <Sparkles className="w-3 h-3" />
            自带思考
          </span>
        )}

        {/* 深度选择器（仅在思考激活且模型支持调节时显示） */}
        {showDepthSelector && (
          <div className="flex items-center bg-cream-100 rounded-lg p-0.5 border border-cream-200">
            {DEPTH_OPTIONS.filter((d) => currentAllowedDepths.includes(d.value)).map((opt) => (
              <button
                key={opt.value}
                onClick={() => setSelectedDepth(opt.value)}
                title={opt.description}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors
                  ${
                    selectedDepth === opt.value
                      ? 'bg-white text-rust-600 shadow-sm'
                      : 'text-charcoal-400 hover:text-charcoal-600'
                  }`}
              >
                {opt.icon}
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

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

        {/* 普通对话 loading 状态 */}
        {isLoading && !keywordSteps && (
          <div className="flex items-center gap-2 animate-chat-bubble-left">
            <div className="w-6 h-6 rounded-full bg-rust-100 flex items-center justify-center">
              <Loader2 className="w-3.5 h-3.5 text-rust-600 animate-spin" />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-charcoal-400">
                {selectedDepth === 'high' ? '深度思考中…' : '思考中…'}
              </span>
              {selectedDepth === 'high' && (
                <span className="text-[10px] text-purple-400 flex items-center gap-1">
                  <Sparkles className="w-2.5 h-2.5" />
                  Extended Thinking 已启用
                </span>
              )}
            </div>
          </div>
        )}

        <div ref={scrollRef} />
      </div>

      {/* Input + 小圈 + 详情卡 */}
      <div className={`border-t border-cream-200 p-3 ${inputSticky ? 'sticky bottom-0 bg-white safe-bottom' : ''}`.trim()}>
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
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Ask about the lecture..."
            className="flex-1 px-3 py-2 rounded-lg border border-cream-300 text-xs
                       focus:outline-none focus:ring-1 focus:ring-rust-400 focus:border-rust-400
                       bg-white text-charcoal-700 placeholder:text-charcoal-300"
            disabled={isLoading}
          />
          <div ref={contextPopoverRef} className="relative">
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
            {showContextPopover && (
              <ContextPopover
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
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            className="p-2 rounded-lg bg-rust-500 text-white hover:bg-rust-600
                       disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
