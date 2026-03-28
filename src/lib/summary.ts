import type { SummaryBlock, SummarizeResponse } from '@/types/summary';

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatSummaryTimeRange(block: SummaryBlock): string {
  return `${formatTimestamp(block.timeRange.startMs)} - ${formatTimestamp(block.timeRange.endMs)}`;
}

export function summaryBlockToResponse(block: SummaryBlock): SummarizeResponse {
  return {
    keyPoints: block.keyPoints,
    definitions: block.definitions,
    summary: block.summary,
    suggestedQuestions: block.suggestedQuestions,
    timeRange: formatSummaryTimeRange(block),
    timestamp: block.timeRange.endMs,
  };
}

export function summaryBlocksToResponses(
  blocks: SummaryBlock[]
): SummarizeResponse[] {
  return blocks.map(summaryBlockToResponse);
}
