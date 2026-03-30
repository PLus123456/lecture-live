import { LocalTranslator } from './localTranslator';

export class TranslationScheduler {
  private localTranslator: LocalTranslator | null = null;
  private pendingSentences: Array<{ id: string; text: string; retries?: number }> = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private batchDelayMs: number;
  private targetLang = '';
  private static readonly MAX_RETRIES = 3;

  private onLocalTranslationResult?: (
    results: Array<{ segmentId: string; translation: string }>
  ) => void;
  private onModelProgress?: (progress: number, status: string) => void;
  private onModelLoaded?: () => void;
  private onError?: (error: unknown) => void;

  constructor(options: {
    batchDelayMs?: number;
    onLocalTranslationResult?: (
      results: Array<{ segmentId: string; translation: string }>
    ) => void;
    onModelProgress?: (progress: number, status: string) => void;
    onModelLoaded?: () => void;
    onError?: (error: unknown) => void;
  }) {
    this.batchDelayMs = options.batchDelayMs ?? 1000;
    this.onLocalTranslationResult = options.onLocalTranslationResult;
    this.onModelProgress = options.onModelProgress;
    this.onModelLoaded = options.onModelLoaded;
    this.onError = options.onError;
  }

  async initLocalTranslator(sourceLang: string, targetLang: string): Promise<void> {
    if (!LocalTranslator.isSupported(sourceLang, targetLang)) {
      throw new Error(`Translation pair ${sourceLang}-${targetLang} not supported locally`);
    }

    this.localTranslator = new LocalTranslator(sourceLang, targetLang);
    await this.localTranslator.initialize((progress, status) => {
      this.onModelProgress?.(progress, status);
    });
    this.onModelLoaded?.();
  }

  /** 设置目标语言，用于同语言 passthrough */
  setTargetLang(lang: string) {
    this.targetLang = lang;
  }

  onFinalizedSentence(segmentId: string, sentence: string, segmentLang?: string) {
    // 如果该段的语言已经是目标语言，直接 passthrough，不走本地模型
    if (segmentLang && this.targetLang && segmentLang === this.targetLang) {
      this.onLocalTranslationResult?.([{ segmentId, translation: sentence }]);
      return;
    }

    if (!this.localTranslator?.loaded) return;

    this.pendingSentences.push({ id: segmentId, text: sentence });

    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flushBatch(), this.batchDelayMs);
    }
  }

  private async flushBatch() {
    const batch = [...this.pendingSentences];
    this.pendingSentences = [];
    this.batchTimer = null;

    if (batch.length === 0 || !this.localTranslator) return;

    try {
      const translations = await this.localTranslator.translateBatch(
        batch.map((b) => b.text)
      );
      const results = batch
        .map((b, i) => ({
          segmentId: b.id,
          translation: translations[i],
        }))
        .filter((r) => r.translation !== undefined);
      if (results.length > 0) {
        this.onLocalTranslationResult?.(results);
      }
    } catch (error) {
      console.error('Local translation batch failed:', error);
      this.onError?.(error);
      // 未超过最大重试次数的句子重新入队
      const retriable = batch.filter((b) => (b.retries ?? 0) < TranslationScheduler.MAX_RETRIES);
      if (retriable.length > 0) {
        this.pendingSentences.push(
          ...retriable.map((b) => ({ ...b, retries: (b.retries ?? 0) + 1 }))
        );
        if (!this.batchTimer) {
          this.batchTimer = setTimeout(() => this.flushBatch(), this.batchDelayMs * 2);
        }
      }
    }
  }

  get isLocalReady(): boolean {
    return this.localTranslator?.loaded ?? false;
  }

  destroy() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.pendingSentences = [];
  }
}
