import { estimateTokens } from '@/lib/llm/tokenizer';

/** 服务端 prompt 与客户端关键词列表共用同一组硬边界。 */
export const MAX_EXISTING_KEYWORDS_UTF8_BYTES = 16 * 1024;
export const MAX_EXISTING_KEYWORDS_COUNT = 200;
export const MAX_EXISTING_KEYWORD_CHARS = 120;
export const MAX_EXISTING_KEYWORDS_TOKENS = 4000;

export const EXISTING_KEYWORD_SEPARATOR = /[,;、，；\r\n]+/u;
const KEYWORD_CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const utf8Encoder = new TextEncoder();

export type ExistingKeywordPolicyFailure =
  | 'invalid_format'
  | 'too_large'
  | 'too_many'
  | 'control_characters'
  | 'item_too_long'
  | 'token_limit';

export type ExistingKeywordPolicyResult =
  | { ok: true; keywords: string[] }
  | { ok: false; reason: ExistingKeywordPolicyFailure };

export function keywordUtf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

export function normalizeKeywordKey(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * 同时校验原始序列化字段与逻辑条目。校验在去重前执行，避免重复项绕过条数/token 上限；
 * 返回值才按 NFKC + 大小写 + 空白语义去重。
 */
export function validateExistingKeywordItems(
  rawItems: ReadonlyArray<string>,
  serialized = JSON.stringify(rawItems)
): ExistingKeywordPolicyResult {
  // UTF-8 字节数不会小于 JS code-unit 数；先短路，避免为明显超大字符串分配编码缓冲。
  if (
    serialized.length > MAX_EXISTING_KEYWORDS_UTF8_BYTES ||
    keywordUtf8ByteLength(serialized) > MAX_EXISTING_KEYWORDS_UTF8_BYTES
  ) {
    return { ok: false, reason: 'too_large' };
  }
  if (rawItems.length > MAX_EXISTING_KEYWORDS_COUNT) {
    return { ok: false, reason: 'too_many' };
  }

  for (const item of rawItems) {
    if (KEYWORD_CONTROL_CHARS.test(item)) {
      return { ok: false, reason: 'control_characters' };
    }
    if (Array.from(item.normalize('NFKC')).length > MAX_EXISTING_KEYWORD_CHARS) {
      return { ok: false, reason: 'item_too_long' };
    }
  }
  if (estimateTokens(rawItems.join('\n')) > MAX_EXISTING_KEYWORDS_TOKENS) {
    return { ok: false, reason: 'token_limit' };
  }

  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const item of rawItems) {
    const trimmed = item.trim();
    const key = normalizeKeywordKey(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keywords.push(trimmed);
  }
  return { ok: true, keywords };
}

export function parseExistingKeywordText(
  serialized: string
): ExistingKeywordPolicyResult {
  if (
    serialized.length > MAX_EXISTING_KEYWORDS_UTF8_BYTES ||
    keywordUtf8ByteLength(serialized) > MAX_EXISTING_KEYWORDS_UTF8_BYTES
  ) {
    return { ok: false, reason: 'too_large' };
  }

  let rawItems: string[];
  if (serialized.trimStart().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (
        !Array.isArray(parsed) ||
        !parsed.every((item) => typeof item === 'string')
      ) {
        return { ok: false, reason: 'invalid_format' };
      }
      rawItems = parsed.map((item) => item.trim());
    } catch {
      return { ok: false, reason: 'invalid_format' };
    }
  } else {
    // 保留旧客户端 CSV/换行协议；新客户端使用 JSON，因此词内逗号/分号不会被误拆。
    rawItems = serialized
      .split(EXISTING_KEYWORD_SEPARATOR)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return validateExistingKeywordItems(rawItems, serialized);
}

export function serializeExistingKeywordItems(
  rawItems: ReadonlyArray<string>
):
  | { ok: true; keywords: string[]; serialized: string }
  | { ok: false; reason: ExistingKeywordPolicyFailure } {
  const serialized = JSON.stringify(rawItems);
  const validation = validateExistingKeywordItems(rawItems, serialized);
  return validation.ok
    ? { ...validation, serialized: JSON.stringify(validation.keywords) }
    : validation;
}
