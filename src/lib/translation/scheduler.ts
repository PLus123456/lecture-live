import { LocalTranslator } from './localTranslator';

export class TranslationScheduler {
  private localTranslator: LocalTranslator | null = null;
  private pendingSentences: Array<{ id: string; text: string }> = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private batchDelayMs: number;
  private targetLang = '';

  private onLocalTranslationResult?: (
    results: Array<{ segmentId: string; translation: string }>
  ) => void;
  private onModelProgress?: (progress: number, status: string) => void;
  private onModelLoaded?: () => void;

  constructor(options: {
    batchDelayMs?: number;
    onLocalTranslationResult?: (
      results: Array<{ segmentId: string; translation: string }>
    ) => void;
    onModelProgress?: (progress: number, status: string) => void;
    onModelLoaded?: () => void;
  }) {
    this.batchDelayMs = options.batchDelayMs ?? 1000;
    this.onLocalTranslationResult = options.onLocalTranslationResult;
    this.onModelProgress = options.onModelProgress;
    this.onModelLoaded = options.onModelLoaded;
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
      const results = batch.map((b, i) => ({
        segmentId: b.id,
        translation: translations[i],
      }));
      this.onLocalTranslationResult?.(results);
    } catch (error) {
      console.error('Local translation batch failed:', error);
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
