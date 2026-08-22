import crypto from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { conservativeLlmCallTokens } from '@/lib/llm/resourceBudget';

export const TRANSLATION_PROXY_TOKEN_BUDGET_BASE = 100_000;
export const TRANSLATION_PROXY_TOKEN_BUDGET_PER_PAGE = 40_000;
export const TRANSLATION_PROXY_MAX_PROMPT_CHARS = 120_000;
/** JSON 结构+转义后的实际请求体硬上限；在 req.json/JSON.parse 前流式计数。 */
export const TRANSLATION_PROXY_MAX_REQUEST_UTF8_BYTES = 1024 * 1024;
export const TRANSLATION_PROXY_MAX_MESSAGES = 256;
export const TRANSLATION_PROXY_MAX_CONTENT_PARTS = 64;
export const TRANSLATION_PROXY_MAX_OUTPUT_TOKENS = 8192;
export const TRANSLATION_PROXY_MAX_RESPONSE_UTF8_BYTES = 40 * 1024;
const TRANSLATION_PROXY_MAX_CACHED_RESULT_BYTES = 60 * 1024;
// JSON.stringify 会把控制字符最多展开成 `\uXXXX`（6倍）。encode/decode
// 必须共享这个上限，否则首次成功的合法 40KiB 结果会在重放时变 corrupt。
const TRANSLATION_PROXY_MAX_DECOMPRESSED_RESULT_BYTES =
  TRANSLATION_PROXY_MAX_RESPONSE_UTF8_BYTES * 6 + 4 * 1024;
const CACHE_VERSION = 1;

export class TranslationProxyRequestError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message);
    this.name = 'TranslationProxyRequestError';
  }
}

export interface ParsedTranslationProxyRequest {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  stream: boolean;
}

export interface TranslationProxyCachedResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  actualTokens: number;
}

/**
 * 不信任 Content-Length：它只做早拒绝，chunked/伪报长度仍按实际流字节
 * 硬截断并 cancel。恶意/失陷 worker 不得在 admission 前让 req.json 物化数十 MB。
 */
export async function readTranslationProxyJson(req: Request): Promise<unknown> {
  const declared = req.headers.get('content-length')?.trim();
  if (declared && /^\d+$/.test(declared)) {
    try {
      if (BigInt(declared) > BigInt(TRANSLATION_PROXY_MAX_REQUEST_UTF8_BYTES)) {
        throw new TranslationProxyRequestError('request body is too large', 413);
      }
    } catch (error) {
      if (error instanceof TranslationProxyRequestError) throw error;
      throw new TranslationProxyRequestError('request body is too large', 413);
    }
  }
  if (!req.body) {
    throw new TranslationProxyRequestError('invalid request body');
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > TRANSLATION_PROXY_MAX_REQUEST_UTF8_BYTES) {
        await reader.cancel('translation proxy body exceeds limit').catch(() => undefined);
        throw new TranslationProxyRequestError('request body is too large', 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TranslationProxyRequestError) throw error;
    throw new TranslationProxyRequestError('invalid request body');
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new TranslationProxyRequestError('invalid request body');
  }
}

export function translationProxyTaskBudget(pageCount: number): number {
  return (
    TRANSLATION_PROXY_TOKEN_BUDGET_BASE +
    Math.max(0, pageCount) * TRANSLATION_PROXY_TOKEN_BUDGET_PER_PAGE
  );
}

export function parseTranslationProxyRequest(
  body: unknown
): ParsedTranslationProxyRequest {
  const record =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const rawMessages = Array.isArray(record.messages) ? record.messages : [];
  if (rawMessages.length > TRANSLATION_PROXY_MAX_MESSAGES) {
    throw new TranslationProxyRequestError('too many messages');
  }

  const systemParts: string[] = [];
  let totalChars = 0;
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const role = (raw as { role?: unknown }).role;
    const content = (raw as { content?: unknown }).content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      if (content.length > TRANSLATION_PROXY_MAX_CONTENT_PARTS) {
        throw new TranslationProxyRequestError('too many message parts');
      }
      const textParts: string[] = [];
      for (const part of content) {
        const partText =
          part &&
          typeof part === 'object' &&
          !Array.isArray(part) &&
          typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : '';
        totalChars += partText.length;
        if (totalChars > TRANSLATION_PROXY_MAX_PROMPT_CHARS) {
          throw new TranslationProxyRequestError('prompt exceeds proxy limit');
        }
        textParts.push(partText);
      }
      text = textParts.join('');
    }
    if (!Array.isArray(content)) {
      totalChars += text.length;
      if (totalChars > TRANSLATION_PROXY_MAX_PROMPT_CHARS) {
        throw new TranslationProxyRequestError('prompt exceeds proxy limit');
      }
    }
    if (role === 'system') {
      systemParts.push(text);
    } else if (role === 'user' || role === 'assistant') {
      messages.push({ role, content: text });
    }
  }
  if (messages.length === 0) {
    throw new TranslationProxyRequestError('messages is empty');
  }
  return {
    system: systemParts.join('\n'),
    messages,
    stream: record.stream === true,
  };
}

export function planTranslationProxyRequest(options: {
  taskId: string;
  modelKey: string;
  system: string;
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  maxOutputTokens: number;
}): { requestHash: string; reservedTokens: number } {
  const serializedMessages = JSON.stringify(options.messages);
  const reservedTokens = conservativeLlmCallTokens(
    options.system,
    serializedMessages,
    options.maxOutputTokens
  );
  const requestHash = crypto
    .createHash('sha256')
    .update('translation-proxy-v1\0')
    .update(options.taskId)
    .update('\0')
    .update(options.modelKey)
    .update('\0')
    .update(String(options.maxOutputTokens))
    .update('\0')
    .update(options.system)
    .update('\0')
    .update(serializedMessages)
    .digest('hex');
  return { requestHash, reservedTokens };
}

export function encodeTranslationProxyCache(
  value: TranslationProxyCachedResult
): string {
  if (
    new TextEncoder().encode(value.text).byteLength >
    TRANSLATION_PROXY_MAX_RESPONSE_UTF8_BYTES
  ) {
    throw new TranslationProxyRequestError('upstream response is too large');
  }
  const payload = JSON.stringify({ version: CACHE_VERSION, ...value });
  if (
    Buffer.byteLength(payload, 'utf8') >
    TRANSLATION_PROXY_MAX_DECOMPRESSED_RESULT_BYTES
  ) {
    throw new TranslationProxyRequestError('upstream response cache is too large');
  }
  const compressed = gzipSync(Buffer.from(payload, 'utf8')).toString('base64');
  if (Buffer.byteLength(compressed, 'utf8') > TRANSLATION_PROXY_MAX_CACHED_RESULT_BYTES) {
    throw new TranslationProxyRequestError('upstream response cache is too large');
  }
  return compressed;
}

export function decodeTranslationProxyCache(
  jobResult: string | null
): TranslationProxyCachedResult | null {
  if (!jobResult) return null;
  try {
    const outer = JSON.parse(jobResult) as { translationProxyCache?: unknown };
    if (typeof outer.translationProxyCache !== 'string') return null;
    const decoded = JSON.parse(
      gunzipSync(Buffer.from(outer.translationProxyCache, 'base64'), {
        maxOutputLength: TRANSLATION_PROXY_MAX_DECOMPRESSED_RESULT_BYTES,
      }).toString('utf8')
    ) as Record<string, unknown>;
    if (
      decoded.version !== CACHE_VERSION ||
      typeof decoded.text !== 'string' ||
      !Number.isSafeInteger(decoded.inputTokens) ||
      (decoded.inputTokens as number) < 0 ||
      !Number.isSafeInteger(decoded.outputTokens) ||
      (decoded.outputTokens as number) < 0 ||
      !Number.isSafeInteger(decoded.actualTokens) ||
      (decoded.actualTokens as number) <= 0 ||
      (decoded.inputTokens as number) + (decoded.outputTokens as number) !==
        decoded.actualTokens
    ) {
      return null;
    }
    if (
      new TextEncoder().encode(decoded.text).byteLength >
      TRANSLATION_PROXY_MAX_RESPONSE_UTF8_BYTES
    ) {
      return null;
    }
    return {
      text: decoded.text,
      inputTokens: decoded.inputTokens as number,
      outputTokens: decoded.outputTokens as number,
      actualTokens: decoded.actualTokens as number,
    };
  } catch {
    return null;
  }
}
