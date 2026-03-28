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
  Zap,
  Brain,
  Sparkles,
} from 'lucide-react';
import type { ThinkingDepth } from '@/types/llm';

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
      if (manualKeywordInput) {
        const manualKeywords = manualKeywordInput
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);

        if (manualKeywords.length === 0) {
          addMessage({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: 'No valid keywords found. Try `/keyword term1, term2`.',
            timestamp: Date.now(),
          });
          return;
        }

        try {
          manualKeywords.forEach(addManualKeyword);
          if (onInjectKeywords) {
            await onInjectKeywords(manualKeywords);
          }
        } catch (error) {
          addMessage({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `Failed to inject manual keywords: ${error instanceof Error ? error.message : 'Unknown error'}`,
            timestamp: Date.now(),
          });
          return;
        }

        addMessage({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Added ${manualKeywords.length} keyword(s) to the ASR context: ${manualKeywords.join(', ')}`,
          timestamp: Date.now(),
        });
        return;
      }

      const recentTranscriptForKeywords = effectiveSegments
        .slice(-60)
        .map((segment) => segment.text)
        .join(' ');

      if (!recentTranscriptForKeywords.trim()) {
        addMessage({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: 'There is not enough transcript yet to extract keywords.',
          timestamp: Date.now(),
        });
        return;
      }

      try {
        const extractedKeywords = await extractFromText(recentTranscriptForKeywords);
        addMessage({
          id: crypto.randomUUID(),
          role: 'assistant',
          content:
            extractedKeywords.length > 0
              ? `Extracted ${extractedKeywords.length} keyword(s). Review them in the Keywords tab and click Inject to rebuild the ASR context.`
              : 'No new keywords were extracted from the current transcript.',
          timestamp: Date.now(),
        });
      } catch (error) {
        addMessage({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Keyword extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          timestamp: Date.now(),
        });
      }

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
          <div
            key={msg.id}
            className={`flex gap-2 ${msg.role === 'user' ? 'justify-end animate-chat-bubble-right' : 'animate-chat-bubble-left'}`}
          >
            {msg.role === 'assistant' && (
              <div className="w-6 h-6 rounded-full bg-rust-100 flex items-center justify-center flex-shrink-0">
                <Bot className="w-3.5 h-3.5 text-rust-600" />
              </div>
            )}
            <div className="max-w-[80%]">
              <div
                className={`px-3 py-2 rounded-lg text-xs leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-charcoal-800 text-white'
                    : 'bg-cream-100 text-charcoal-700'
                }`}
              >
                {msg.content}
              </div>
              {/* Model/depth indicator for assistant messages */}
              {msg.role === 'assistant' && msg.model && (
                <div className="flex items-center gap-1.5 mt-0.5 pl-1">
                  <span className="text-[10px] text-charcoal-300">
                    {msg.model}
                  </span>
                  {msg.thinkingDepth && msg.thinkingDepth !== 'medium' && (
                    <span className={`text-[10px] px-1 py-0.5 rounded ${
                      msg.thinkingDepth === 'high'
                        ? 'bg-purple-50 text-purple-500'
                        : 'bg-cream-100 text-charcoal-400'
                    }`}>
                      {msg.thinkingDepth}
                    </span>
                  )}
                </div>
              )}
            </div>
            {msg.role === 'user' && (
              <div className="w-6 h-6 rounded-full bg-charcoal-200 flex items-center justify-center flex-shrink-0">
                <User className="w-3.5 h-3.5 text-charcoal-600" />
              </div>
            )}
          </div>
        ))}

        {isLoading && (
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-rust-100 flex items-center justify-center">
              <Loader2 className="w-3.5 h-3.5 text-rust-600 animate-spin" />
            </div>
            <span className="text-xs text-charcoal-400">
              {selectedDepth === 'high' ? 'Thinking deeply...' : 'Thinking...'}
            </span>
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
