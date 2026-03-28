'use client';

import { useSummaryStore } from '@/stores/summaryStore';
import {
  Sparkles,
  Lock,
  Loader2,
  RefreshCw,
  BookOpen,
  HelpCircle,
} from 'lucide-react';

function formatTimeRange(startMs: number, endMs: number): string {
  const fmt = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };
  return `${fmt(startMs)} - ${fmt(endMs)}`;
}

export default function SummaryTab({
  onManualTrigger,
}: {
  onManualTrigger?: () => void;
}) {
  const blocks = useSummaryStore((s) => s.blocks);
  const isLoading = useSummaryStore((s) => s.isLoading);
  const currentBatchSentences = useSummaryStore((s) => s.currentBatchSentences);

  return (
    <div className="flex flex-col h-full">
      {/* Controls */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-cream-100">
        {currentBatchSentences > 0 && (
          <span className="text-[11px] text-charcoal-400">
            {currentBatchSentences} sentences buffered
          </span>
        )}
        <div className="ml-auto">
          <button
            onClick={onManualTrigger}
            disabled={isLoading}
            className="btn-ghost text-xs flex items-center gap-1"
          >
            {isLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Summarize
          </button>
        </div>
      </div>

      {/* Blocks */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && blocks.length === 0 && (
          <div className="flex items-center gap-2 px-4 py-3 bg-rust-50 border-b border-rust-100">
            <Loader2 className="w-4 h-4 text-rust-500 animate-spin" />
            <span className="text-xs text-rust-600">Analyzing transcript...</span>
          </div>
        )}

        {blocks.map((block) => (
          <div
            key={block.id}
            className={`px-4 py-3 border-b border-cream-100 animate-fade-in-up ${
              block.frozen ? 'bg-cream-50/50' : 'border-l-2 border-l-rust-400'
            }`}
          >
            {/* Block header */}
            <div className="flex items-center gap-2 mb-2">
              {block.frozen ? (
                <Lock className="w-3 h-3 text-charcoal-300" />
              ) : (
                <Sparkles className="w-3 h-3 text-rust-500" />
              )}
              <span className="text-[11px] font-mono text-charcoal-400">
                Block #{block.blockIndex + 1} ({formatTimeRange(block.timeRange.startMs, block.timeRange.endMs)})
              </span>
              {!block.frozen && (
                <span className="text-[10px] text-rust-500 ml-auto">active</span>
              )}
            </div>

            {/* Key points */}
            {block.keyPoints.length > 0 && (
              <ul className="space-y-1 mb-2">
                {block.keyPoints.map((point, i) => (
                  <li key={i} className="flex gap-2 text-xs text-charcoal-700">
                    <span className="text-rust-400 mt-0.5 flex-shrink-0">&#8226;</span>
                    <span className="leading-relaxed">{point}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* Definitions */}
            {Object.keys(block.definitions).length > 0 && (
              <div className="mb-2">
                <div className="flex items-center gap-1 mb-1">
                  <BookOpen className="w-3 h-3 text-charcoal-400" />
                  <span className="text-[10px] text-charcoal-400 uppercase">Terms</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(block.definitions).map(([term, def]) => (
                    <span
                      key={term}
                      className="inline-flex items-center px-2 py-0.5 rounded text-[11px]
                                 bg-rust-50 text-rust-700 border border-rust-200 cursor-help"
                      title={def}
                    >
                      {term}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Questions */}
            {block.suggestedQuestions.length > 0 && (
              <div>
                <div className="flex items-center gap-1 mb-1">
                  <HelpCircle className="w-3 h-3 text-charcoal-400" />
                  <span className="text-[10px] text-charcoal-400 uppercase">Review</span>
                </div>
                <ol className="space-y-0.5 list-decimal list-inside">
                  {block.suggestedQuestions.map((q, i) => (
                    <li key={i} className="text-[11px] text-charcoal-600 leading-relaxed">
                      {q}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        ))}

        {/* Empty state */}
        {blocks.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center py-8 text-charcoal-300">
            <Sparkles className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-xs">AI summaries will appear here</p>
            <p className="text-[11px] mt-1">Auto-generated every ~12 sentences</p>
          </div>
        )}
      </div>
    </div>
  );
}
