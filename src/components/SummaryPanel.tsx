'use client';

import { useState } from 'react';
import { useSummaryStore } from '@/stores/summaryStore';
import type { SummaryBlock } from '@/types/summary';
import {
  Sparkles,
  ChevronDown,
  ChevronUp,
  BookOpen,
  HelpCircle,
  Loader2,
  RefreshCw,
} from 'lucide-react';

export default function SummaryPanel({
  onManualTrigger,
}: {
  onManualTrigger?: () => void;
}) {
  const blocks = useSummaryStore((s) => s.blocks);
  const isLoading = useSummaryStore((s) => s.isLoading);
  const currentBatchSentences = useSummaryStore((s) => s.currentBatchSentences);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const latestSummary =
    blocks.length > 0 ? blocks[blocks.length - 1] : null;

  return (
    <div className="panel-card flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-cream-200">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-rust-500" />
          <h2 className="font-serif font-semibold text-charcoal-800 text-sm">
            Live Synthesis
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {currentBatchSentences > 0 && (
            <span className="text-[11px] text-charcoal-400">
              {currentBatchSentences} sentences buffered
            </span>
          )}
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
            Generate Summary
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="overflow-y-auto max-h-[400px]">
        {/* Loading state */}
        {isLoading && (
          <div className="flex items-center gap-2 px-5 py-3 bg-rust-50 border-b border-rust-100">
            <Loader2 className="w-4 h-4 text-rust-500 animate-spin" />
            <span className="text-xs text-rust-600">Analyzing transcript...</span>
          </div>
        )}

        {/* Latest summary (always visible) */}
        {latestSummary && (
          <div className="px-5 py-4 space-y-4">
            {/* Key Takeaways */}
            {latestSummary.keyPoints && latestSummary.keyPoints.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider mb-2">
                  Key Takeaways
                </h3>
                <ul className="space-y-1.5">
                  {latestSummary.keyPoints.map((point: string, i: number) => (
                    <li key={i} className="flex gap-2 text-sm text-charcoal-700">
                      <span className="text-rust-400 mt-0.5 flex-shrink-0">&#8226;</span>
                      <span className="leading-relaxed">{point}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Extracted Terms */}
            {latestSummary.definitions &&
              Object.keys(latestSummary.definitions).length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <BookOpen className="w-3 h-3" />
                    Extracted Terms
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(latestSummary.definitions).map(
                      ([term, def]: [string, string]) => (
                      <span
                        key={term}
                        className="inline-flex items-center px-2.5 py-1 rounded-md text-xs
                                   bg-rust-50 text-rust-700 border border-rust-200
                                   cursor-help"
                        title={def}
                      >
                        {term}
                      </span>
                      )
                    )}
                  </div>
                </div>
              )}

            {/* Review Questions */}
            {latestSummary.suggestedQuestions &&
              latestSummary.suggestedQuestions.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <HelpCircle className="w-3 h-3" />
                    Review Questions
                  </h3>
                  <ol className="space-y-1 list-decimal list-inside">
                    {latestSummary.suggestedQuestions.map(
                      (q: string, i: number) => (
                      <li key={i} className="text-xs text-charcoal-600 leading-relaxed">
                        {q}
                      </li>
                      )
                    )}
                  </ol>
                </div>
              )}
          </div>
        )}

        {/* Empty state */}
        {!latestSummary && !isLoading && (
          <div className="flex flex-col items-center justify-center py-8 text-charcoal-300">
            <Sparkles className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-xs">AI summaries will appear here</p>
            <p className="text-[11px] mt-1">Auto-generated every ~12 sentences</p>
          </div>
        )}

        {/* History (collapsible) */}
        {blocks.length > 1 && (
          <div className="border-t border-cream-200">
            <button
              onClick={() => setExpandedIndex(expandedIndex !== null ? null : 0)}
              className="w-full px-5 py-2 flex items-center justify-between text-xs text-charcoal-400 hover:bg-cream-50"
            >
              <span>{blocks.length - 1} previous summaries</span>
              {expandedIndex !== null ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
            </button>
            {expandedIndex !== null && (
              <div className="px-5 pb-4 space-y-3">
                {blocks
                  .slice(0, -1)
                  .reverse()
                  .map((s: SummaryBlock, i: number) => (
                  <div key={i} className="text-xs text-charcoal-500 border-l-2 border-cream-300 pl-3">
                    {s.summary && <p className="italic">{s.summary}</p>}
                    {s.keyPoints && (
                      <ul className="mt-1 space-y-0.5">
                        {s.keyPoints.map((p: string, j: number) => (
                          <li key={j}>&#8226; {p}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
