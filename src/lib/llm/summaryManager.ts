import type { SummaryBlock, SummaryState, IncrementalSummaryResult } from '@/types/summary';

export class SummaryManager {
  private state: SummaryState = { blocks: [], runningContext: '' };
  private transcriptBuffer: string[] = [];
  private sentenceCount = 0;
  private lastSummaryTime = Date.now();
  private recordingStartMs = Date.now();
  private currentStartMs = 0;
  private courseContext: string;
  private targetLanguage: string;
  private triggerSentences: number;
  private triggerMinutes: number;
  private providerOverride?: string;
  private authToken: string;

  private onStateUpdate?: (state: SummaryState) => void;
  private onSummaryStart?: () => void;
  private onSummaryError?: (error: string) => void;

  constructor(options: {
    courseContext?: string;
    targetLanguage?: string;
    triggerSentences?: number;
    triggerMinutes?: number;
    providerOverride?: string;
    authToken: string;
    onStateUpdate?: (state: SummaryState) => void;
    onSummaryStart?: () => void;
    onSummaryError?: (error: string) => void;
  }) {
    this.courseContext = options.courseContext ?? 'General university lecture';
    this.targetLanguage = options.targetLanguage ?? 'zh';
    this.triggerSentences = options.triggerSentences ?? 12;
    this.triggerMinutes = options.triggerMinutes ?? 3;
    this.providerOverride = options.providerOverride;
    this.authToken = options.authToken;
    this.onStateUpdate = options.onStateUpdate;
    this.onSummaryStart = options.onSummaryStart;
    this.onSummaryError = options.onSummaryError;
  }

  setRecordingStartMs(ms: number) {
    this.recordingStartMs = ms;
  }

  onNewSentence(sentence: string) {
    this.transcriptBuffer.push(sentence);
    this.sentenceCount++;

    if (
      this.sentenceCount >= this.triggerSentences ||
      Date.now() - this.lastSummaryTime > this.triggerMinutes * 60_000
    ) {
      this.triggerIncrementalSummary();
    }
  }

  async triggerIncrementalSummary() {
    if (this.transcriptBuffer.length === 0) return;

    const newTranscript = this.transcriptBuffer.join(' ');
    this.transcriptBuffer = [];
    this.sentenceCount = 0;
    this.lastSummaryTime = Date.now();

    this.onSummaryStart?.();

    // 冻结上一个 block
    if (this.state.blocks.length > 0) {
      this.state.blocks[this.state.blocks.length - 1].frozen = true;
    }

    try {
      const res = await fetch('/api/llm/summarize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({
          newTranscript,
          runningContext: this.state.runningContext,
          courseContext: this.courseContext,
          language: this.targetLanguage,
          providerOverride: this.providerOverride,
        }),
      });

      if (!res.ok) {
        throw new Error(`Summary API returned ${res.status}`);
      }

      const result: IncrementalSummaryResult = await res.json();

      // 追加新 block（不修改任何旧 block）
      const newBlock: SummaryBlock = {
        id: crypto.randomUUID(),
        blockIndex: this.state.blocks.length,
        timeRange: {
          startMs: this.currentStartMs,
          endMs: Date.now() - this.recordingStartMs,
        },
        keyPoints: result.new_key_points,
        definitions: result.new_definitions,
        summary: result.new_summary,
        suggestedQuestions: result.new_questions,
        frozen: false, // 当前 block 是 active 的
      };

      this.state.blocks.push(newBlock);
      this.state.runningContext = result.updated_running_context;
      this.currentStartMs = newBlock.timeRange.endMs;

      this.onStateUpdate?.(this.state);
    } catch (error) {
      // 失败时 buffer 保留，下次重试
      this.transcriptBuffer.unshift(newTranscript);
      this.onSummaryError?.(
        error instanceof Error ? error.message : 'Summary failed'
      );
    }
  }

  get currentState(): SummaryState {
    return this.state;
  }

  get bufferedSentenceCount(): number {
    return this.sentenceCount;
  }

  reset() {
    this.state = { blocks: [], runningContext: '' };
    this.transcriptBuffer = [];
    this.sentenceCount = 0;
    this.lastSummaryTime = Date.now();
    this.currentStartMs = 0;
  }
}
