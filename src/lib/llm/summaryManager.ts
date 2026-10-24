import type { SummaryBlock, SummaryState, IncrementalSummaryResult } from '@/types/summary';

/** 一句话在录音时间轴上的位置（与转录段落 globalStartMs/globalEndMs 同一时间轴，已扣除暂停）。 */
export interface SentenceTiming {
  startMs: number;
  endMs: number;
}

export class SummaryManager {
  private state: SummaryState = { blocks: [], runningContext: '' };
  private transcriptBuffer: string[] = [];
  private sentenceCount = 0;
  // in-flight 锁：自动 onNewSentence 路径无 loading 门控，语速快 + LLM 慢时会在上一次
  // summarize 还在 await 时再次触发，两次都基于同一 runningContext（C0）请求，后 resolve
  // 的覆盖前者、丢掉另一 block 的内容（v3 finding U75）。用它保证同一时刻只有一个
  // summarize 在写 runningContext；忙碌时早退、句子留在 buffer 折进下一次。
  private isSummarizing = false;
  // 代次（M15）：reset() 递增。in-flight 的 summarize 在每个 await 之后都要校验代次——
  // 否则「请求在途时用户新建录制/重置」会让旧请求 resolve 后继续 push block、改
  // runningContext、并触发构造时捕获的 onStateUpdate 闭包（直写全局 zustand store），
  // 把上一场录音的总结污染进新 session。
  private generation = 0;
  private inflightAbort: AbortController | null = null;
  /** L41：连续失败次数 + 退避截止时间（成功即清零） */
  private consecutiveFailures = 0;
  private retryNotBefore = 0;
  private lastSummaryTime = Date.now();

  /** L41：失败重试的指数退避基数 / 上限 */
  private static readonly BASE_RETRY_BACKOFF_MS = 30_000;
  private static readonly MAX_RETRY_BACKOFF_MS = 5 * 60_000;
  /** L41：buffer 总字符上限（服务端 newTranscript 上限是 50K，这里留出余量） */
  private static readonly MAX_BUFFERED_CHARS = 40_000;
  private recordingStartMs = Date.now();
  private currentStartMs = 0;
  // 审计 #6：block 的时间范围必须落在录音时间轴上（与转录段落时间戳、回放音频一致）。此前只用
  // 「Date.now() − 构造时刻」：manager 在页面挂载时构造、setRecordingStartMs 从未被调用 →
  // 范围包含开录前的空闲与全部暂停时长，还含 LLM 响应耗时。现按本批句子的段落时间戳计算；
  // 调用方没给时间戳时才退回旧的墙钟估算。
  private bufferStartMs: number | null = null;
  private bufferEndMs: number | null = null;
  private courseContext: string;
  private targetLanguage: string;
  private triggerSentences: number;
  private triggerMinutes: number;
  private providerOverride?: string;
  private authToken: string;

  private onStateUpdate?: (state: SummaryState) => void;
  private onSummaryStart?: () => void;
  private onSummaryError?: (error: string) => void;
  private getBaseline?: () => SummaryState;

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
    /**
     * 审计 #6：本 manager 尚未产出任何 block 时，从这里接续已有的块与滚动上下文（页面刷新 /
     * 冷恢复后新建的 manager 否则会从「Block #1、00:00、空上下文」重新开始）。惰性读取：冷恢复
     * 的后端草稿是在 manager 构造之后才异步灌进 store 的。
     */
    getBaseline?: () => SummaryState;
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
    this.getBaseline = options.getBaseline;
  }

  setRecordingStartMs(ms: number) {
    this.recordingStartMs = ms;
  }

  onNewSentence(sentence: string, timing?: SentenceTiming) {
    this.transcriptBuffer.push(sentence);
    this.sentenceCount++;
    if (timing) this.extendBufferRange(timing.startMs, timing.endMs);

    if (
      this.sentenceCount >= this.triggerSentences ||
      Date.now() - this.lastSummaryTime > this.triggerMinutes * 60_000
    ) {
      this.triggerIncrementalSummary();
    }
  }

  async triggerIncrementalSummary() {
    if (this.transcriptBuffer.length === 0) return;
    // in-flight 守卫：已有一次 summarize 在进行时直接早退，句子仍留在 buffer，
    // 待本次完成后由下一次触发一并折进去 —— 避免并发请求基于同一旧 runningContext
    // 互相覆盖丢内容。
    if (this.isSummarizing) return;
    // L41 退避：失败会把原文 unshift 回 buffer，若不退避就会每 12 句 / 3 分钟原样重打
    // 同一份必败请求（如输入超模型窗口、quota 用尽），一路循环失败到用户新建会话。
    if (Date.now() < this.retryNotBefore) return;
    this.isSummarizing = true;

    // 代次快照：本次请求所有 await 之后的副作用都必须先校验它仍等于 this.generation。
    const gen = this.generation;
    const abort = new AbortController();
    this.inflightAbort = abort;

    this.adoptBaselineIfFresh();

    const newTranscript = this.transcriptBuffer.join(' ');
    // 本批句子的时间范围在发请求时快照：结果回来时 buffer 里可能已有新句子。
    const batchStartMs = this.bufferStartMs;
    const batchEndMs = this.bufferEndMs;
    this.transcriptBuffer = [];
    this.bufferStartMs = null;
    this.bufferEndMs = null;
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
        signal: abort.signal,
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

      // reset() 已发生 → 本次结果属于上一场录音，静默丢弃（含尚未消费的 body）。
      if (gen !== this.generation) return;

      if (!res.ok) {
        throw new Error(`Summary API returned ${res.status}`);
      }

      const result: IncrementalSummaryResult = await res.json();
      // json() 也是一次 await —— 期间同样可能 reset()。
      if (gen !== this.generation) return;

      // 追加新 block（不修改任何旧 block）
      // 起点接续上一块的终点（块首尾相接）；若接续来的旧块终点晚于本批第一句（旧版墙钟数据），
      // 取本批第一句，避免出现起点晚于终点的倒置范围。
      const startMs = batchStartMs === null
        ? this.currentStartMs
        : Math.min(this.currentStartMs, batchStartMs);
      const endMs = batchEndMs === null
        ? Date.now() - this.recordingStartMs
        : Math.max(batchEndMs, startMs);
      const newBlock: SummaryBlock = {
        id: crypto.randomUUID(),
        blockIndex: this.state.blocks.length,
        timeRange: { startMs, endMs },
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
      this.consecutiveFailures = 0;
      this.retryNotBefore = 0;
    } catch (error) {
      // 旧代次的失败（含 reset() 主动 abort 掉的那次）不许回写任何状态、不许报错给 UI。
      if (gen !== this.generation) return;
      // 失败时 buffer 保留，下次重试（时间范围一并并回）
      this.transcriptBuffer.unshift(newTranscript);
      if (batchStartMs !== null && batchEndMs !== null) {
        this.extendBufferRange(batchStartMs, batchEndMs);
      }
      this.trimBufferToLimit();
      this.consecutiveFailures += 1;
      // 指数退避（30s → 60s → … 封顶 5 分钟），避免必败请求每个触发周期重打一次。
      this.retryNotBefore =
        Date.now() +
        Math.min(
          SummaryManager.MAX_RETRY_BACKOFF_MS,
          SummaryManager.BASE_RETRY_BACKOFF_MS * 2 ** (this.consecutiveFailures - 1)
        );
      this.onSummaryError?.(
        error instanceof Error ? error.message : 'Summary failed'
      );
    } finally {
      // 无论成败都释放锁；失败时 newTranscript 已放回 buffer，下次触发会重试。
      // 但只有「本代次仍是当前代次」才动这两个字段 —— reset() 已经把它们清成新一代的
      // 初始态（甚至新一代已经开了新的请求），旧代次的收尾不能覆盖。
      if (gen === this.generation) {
        this.isSummarizing = false;
        this.inflightAbort = null;
      }
    }
  }

  private extendBufferRange(startMs: number, endMs: number): void {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    this.bufferStartMs = this.bufferStartMs === null ? startMs : Math.min(this.bufferStartMs, startMs);
    this.bufferEndMs = this.bufferEndMs === null ? endMs : Math.max(this.bufferEndMs, endMs);
  }

  /** 审计 #6：本 manager 还没有自己的块时，接续 baseline（store 里本会话已有的块与上下文）。 */
  private adoptBaselineIfFresh(): void {
    if (!this.getBaseline || this.state.blocks.length > 0 || this.state.runningContext) return;
    const baseline = this.getBaseline();
    if (baseline.blocks.length === 0 && !baseline.runningContext) return;
    // 浅拷贝每个块：下面「冻结上一个 block」会改 frozen，不能就地改 store 里的对象。
    this.state = {
      blocks: baseline.blocks.map((block) => ({ ...block })),
      runningContext: baseline.runningContext,
    };
    const lastEndMs = baseline.blocks[baseline.blocks.length - 1]?.timeRange?.endMs;
    if (typeof lastEndMs === 'number' && Number.isFinite(lastEndMs)) {
      this.currentStartMs = lastEndMs;
    }
  }

  /**
   * L41：失败重试会把整段原文塞回 buffer，若上游持续失败且录音继续，buffer 会无限增长，
   * 最终超过服务端 newTranscript 50K 字符上限 → 从「偶发失败」变成「永久 400」。
   * 这里给 buffer 总字符数封顶，超出时丢最旧的片段并留一条标记。
   */
  private trimBufferToLimit(): void {
    let total = this.transcriptBuffer.reduce((acc, s) => acc + s.length, 0);
    if (total <= SummaryManager.MAX_BUFFERED_CHARS) return;
    let dropped = 0;
    while (
      this.transcriptBuffer.length > 1 &&
      total > SummaryManager.MAX_BUFFERED_CHARS
    ) {
      const removed = this.transcriptBuffer.shift();
      total -= removed?.length ?? 0;
      dropped += 1;
    }
    if (dropped > 0) {
      this.transcriptBuffer.unshift('[部分较早内容因摘要重试积压已丢弃]');
    }
  }

  get currentState(): SummaryState {
    return this.state;
  }

  get bufferedSentenceCount(): number {
    return this.sentenceCount;
  }

  reset() {
    // 先 bump 代次再清状态：in-flight 的 summarize 在任一 await 之后校验代次即会
    // 静默早退，不再写进已经属于新一场录音的 state / store（M15）。
    this.generation += 1;
    // 顺带取消在途请求，省掉一次不会被采纳的 LLM 往返与计费。
    this.inflightAbort?.abort();
    this.inflightAbort = null;
    this.isSummarizing = false;
    this.consecutiveFailures = 0;
    this.retryNotBefore = 0;
    this.state = { blocks: [], runningContext: '' };
    this.transcriptBuffer = [];
    this.bufferStartMs = null;
    this.bufferEndMs = null;
    this.sentenceCount = 0;
    this.lastSummaryTime = Date.now();
    this.currentStartMs = 0;
  }
}
