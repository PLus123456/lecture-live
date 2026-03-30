/**
 * Local Translation using Transformers.js (ONNX Runtime Web)
 *
 * Runs Helsinki-NLP opus-mt translation models entirely in the browser.
 * Prefers WebGPU for acceleration, falls back to WASM.
 */

type TranslationPipeline = (
  texts: string | string[],
  options?: { max_length?: number }
) => Promise<Array<{ translation_text: string }>>;

const MODELS: Record<string, string> = {
  'en-zh': 'Xenova/opus-mt-en-zh',
  'zh-en': 'Xenova/opus-mt-zh-en',
  'en-ja': 'Xenova/opus-mt-en-jap',
  'en-ko': 'Xenova/opus-mt-tc-big-en-ko',
  'en-fr': 'Xenova/opus-mt-en-fr',
  'en-de': 'Xenova/opus-mt-en-de',
  'en-es': 'Xenova/opus-mt-en-es',
  'de-en': 'Xenova/opus-mt-de-en',
  'fr-en': 'Xenova/opus-mt-fr-en',
  'es-en': 'Xenova/opus-mt-es-en',
  'ja-en': 'Xenova/opus-mt-jap-en',
};

export class LocalTranslator {
  private translator: TranslationPipeline | null = null;
  private isLoading = false;
  private modelId: string;

  static getSupportedPairs(): string[] {
    return Object.keys(MODELS);
  }

  static isSupported(sourceLang: string, targetLang: string): boolean {
    return `${sourceLang}-${targetLang}` in MODELS;
  }

  constructor(sourceLang: string, targetLang: string) {
    const key = `${sourceLang}-${targetLang}`;
    this.modelId = MODELS[key];
    if (!this.modelId) {
      throw new Error(`Unsupported translation pair: ${key}. Supported: ${Object.keys(MODELS).join(', ')}`);
    }
  }

  async initialize(onProgress?: (progress: number, status: string) => void): Promise<void> {
    if (this.translator || this.isLoading) return;
    this.isLoading = true;

    try {
      const { pipeline } = await import('@huggingface/transformers');

      onProgress?.(0, 'Loading translation model...');

      try {
        // Try WebGPU first for maximum performance
        this.translator = (await pipeline('translation', this.modelId, {
          device: 'webgpu' as 'cpu',
          dtype: 'fp16' as 'fp32',
          progress_callback: (data: { status: string; progress?: number }) => {
            if (data.status === 'progress' && data.progress !== undefined) {
              onProgress?.(data.progress, 'Downloading model (WebGPU)...');
            }
          },
        })) as unknown as TranslationPipeline;
        onProgress?.(100, 'Model loaded (WebGPU)');
      } catch {
        // Fall back to WASM
        console.warn('WebGPU unavailable, falling back to WASM');
        onProgress?.(0, 'Falling back to WASM...');

        this.translator = (await pipeline('translation', this.modelId, {
          device: 'wasm' as 'cpu',
          progress_callback: (data: { status: string; progress?: number }) => {
            if (data.status === 'progress' && data.progress !== undefined) {
              onProgress?.(data.progress, 'Downloading model (WASM)...');
            }
          },
        })) as unknown as TranslationPipeline;
        onProgress?.(100, 'Model loaded (WASM)');
      }
    } finally {
      this.isLoading = false;
    }
  }

  async translate(text: string): Promise<string> {
    if (!this.translator) throw new Error('Translator not initialized');
    const result = await this.translator(text, { max_length: 512 });
    if (!result || result.length === 0) {
      throw new Error('Translation returned empty result');
    }
    return result[0].translation_text;
  }

  async translateBatch(texts: string[]): Promise<string[]> {
    if (!this.translator) throw new Error('Translator not initialized');
    if (texts.length === 0) return [];
    const results = await this.translator(texts, { max_length: 512 });
    return results.map((r) => r.translation_text);
  }

  get loaded(): boolean {
    return this.translator !== null;
  }

  get loading(): boolean {
    return this.isLoading;
  }
}
