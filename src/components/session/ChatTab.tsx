'use client';

import { useState, useRef, useEffect } from 'react';
import { useChat } from '@/hooks/useChat';
import { useKeywords } from '@/hooks/useKeywords';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useChatStore } from '@/stores/chatStore';
import { useSummaryStore } from '@/stores/summaryStore';
import {
  Send,
  Loader2,
  User,
  Bot,
  ChevronDown,
  ChevronRight,
  Zap,
  Brain,
  Sparkles,
  CheckCircle2,
  XCircle,
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
  const {
    messages,
    isLoading,
    selectedModel,
    selectedDepth,
    availableModels,
    sendMessage,
    setSelectedModel,
    setSelectedDepth,
  } = useChat();
  const { extractFromText, addManualKeyword } = useKeywords();
  const addMessage = useChatStore((s) => s.addMessage);

  const [input, setInput] = useState('');
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [keywordSteps, setKeywordSteps] = useState<KeywordStep[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  const segments = useTranscriptStore((s) => s.segments);
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

  const handleSend = async () => {
    const value = input.trim();
    if (!value || isLoading) return;

    setInput('');

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

    const recentTranscript = effectiveSegments
      .slice(-20)
      .map((s) => s.text)
      .join(' ');

    const summaryContext = effectiveBlocks
      .map((b) => b.summary)
      .filter(Boolean)
      .join('\n');

    sendMessage(value, recentTranscript, summaryContext);
  };

  // Current model display info
  const currentModelInfo = availableModels.find((m) => m.name === selectedModel);
  const currentModelLabel = currentModelInfo?.displayName || selectedModel || 'Default';

  // Allowed depths for current model
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
            <div className="absolute top-full mt-1 left-0 w-52 bg-white border border-cream-300
                            rounded-lg shadow-lg z-50 py-1 animate-fade-in-scale">
              {availableModels.map((model) => (
                <button
                  key={model.name}
                  onClick={() => {
                    setSelectedModel(model.name);
                    // Reset depth if current depth not supported by new model
                    if (!model.allowedDepths.includes(selectedDepth)) {
                      setSelectedDepth('medium');
                    }
                    setShowModelMenu(false);
                  }}
                  className={`w-full text-left px-3 py-2 text-xs hover:bg-cream-50 transition-colors
                    ${selectedModel === model.name ? 'text-rust-600 bg-rust-50' : 'text-charcoal-600'}`}
                >
                  <div className="font-medium">{model.displayName}</div>
                  <div className="text-[10px] text-charcoal-400 mt-0.5">
                    {model.supportsThinking ? 'Supports deep thinking' : 'Standard mode'}
                  </div>
                </button>
              ))}

              {availableModels.length === 0 && (
                <div className="px-3 py-2 text-xs text-charcoal-400">
                  No models available
                </div>
              )}
            </div>
          )}
        </div>

        {/* Depth toggle pills */}
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
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
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

      {/* Input */}
      <div className={`border-t border-cream-200 p-3 ${inputSticky ? 'sticky bottom-0 bg-white safe-bottom' : ''}`.trim()}>
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
