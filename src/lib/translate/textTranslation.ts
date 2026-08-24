import 'server-only';

import { getRedisClient } from '@/lib/redis';

/**
 * 句子翻译（翻译页文本 tab）的服务端支撑：
 *  - 免费模式每日次数额度（Redis 优先、内存兜底，跨进程口径尽量一致）
 *  - 翻译 prompt 构建（只输出译文，不解释）
 * 计费模式（free / per_char）与模型解析在路由层组装，这里只提供纯支撑件。
 */

/** 内存兜底的每日计数（Redis 不可用时单进程内近似；重启即清，宽松可接受） */
const memoryDailyCounts = new Map<string, { day: string; count: number }>();

/**
 * L56：内存兜底 Map 原本只写不清 —— 条目按 userId 累积、跨日也不删，
 * Redis 长期不可用 + 大量用户时会缓慢泄漏。这里在写入时顺带清理：
 * 先丢掉所有「不是今天」的条目（它们的计数已经无意义），再对总量兜个上界。
 */
const MEMORY_DAILY_MAX_ENTRIES = 50_000;

function pruneMemoryDailyCounts(today: string) {
  memoryDailyCounts.forEach((entry, userId) => {
    if (entry.day !== today) memoryDailyCounts.delete(userId);
  });

  if (memoryDailyCounts.size <= MEMORY_DAILY_MAX_ENTRIES) return;
  // 同一天内条目仍可能过多（极端场景）：丢最早插入的一批（Map 保持插入序）。
  const overflow = memoryDailyCounts.size - MEMORY_DAILY_MAX_ENTRIES;
  let dropped = 0;
  for (const userId of memoryDailyCounts.keys()) {
    if (dropped >= overflow) break;
    memoryDailyCounts.delete(userId);
    dropped += 1;
  }
}

/** 仅供测试：查看内存兜底 Map 的当前条目数。 */
export function __memoryDailyCountSize(): number {
  return memoryDailyCounts.size;
}

function utcDayStamp(now = new Date()): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(
    now.getUTCDate()
  ).padStart(2, '0')}`;
}

export interface DailyQuotaResult {
  allowed: boolean;
  used: number; // 含本次（allowed=true 时）
  limit: number; // 0=不限
}

/**
 * 消耗一次「每日免费句子翻译」额度（请求时预消耗）。
 * limit<=0 视为不限；超限返回 allowed=false 且不再累计。
 */
export async function consumeDailyTextQuota(
  userId: string,
  limit: number
): Promise<DailyQuotaResult> {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, used: 0, limit: 0 };
  }
  const day = utcDayStamp();
  const redis = getRedisClient();
  if (redis) {
    try {
      const key = `translate:text:daily:${userId}:${day}`;
      const used = await redis.incr(key);
      if (used === 1) {
        // 48h 过期：覆盖整个 UTC 日 + 时区余量，无需精确对齐零点
        await redis.expire(key, 48 * 3600);
      }
      if (used > limit) {
        // 超限的这次 INCR 不回滚：计数只增，used>limit 恒拒绝，语义稳定
        return { allowed: false, used: limit, limit };
      }
      return { allowed: true, used, limit };
    } catch {
      // Redis 抖动 → 落内存兜底
    }
  }
  pruneMemoryDailyCounts(day);
  const entry = memoryDailyCounts.get(userId);
  const current = entry && entry.day === day ? entry.count : 0;
  if (current >= limit) {
    return { allowed: false, used: limit, limit };
  }
  memoryDailyCounts.set(userId, { day, count: current + 1 });
  return { allowed: true, used: current + 1, limit };
}

/** 失败回滚一次额度（best effort：LLM 调用彻底失败时把预消耗的次数还回去） */
export async function releaseDailyTextQuota(userId: string): Promise<void> {
  const day = utcDayStamp();
  const redis = getRedisClient();
  if (redis) {
    try {
      const key = `translate:text:daily:${userId}:${day}`;
      const val = await redis.decr(key);
      if (val < 0) await redis.set(key, '0', 'KEEPTTL');
      return;
    } catch {
      // 忽略，落内存
    }
  }
  const entry = memoryDailyCounts.get(userId);
  if (entry && entry.day === day && entry.count > 0) {
    entry.count -= 1;
  }
}

/** 常见语言代码 → 英文全名（喂给 LLM 更稳；未知代码原样传递） */
const LANGUAGE_NAMES: Record<string, string> = {
  auto: 'auto-detect',
  zh: 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  pt: 'Portuguese',
  ru: 'Russian',
  it: 'Italian',
  ar: 'Arabic',
  hi: 'Hindi',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
  ms: 'Malay',
  tr: 'Turkish',
  nl: 'Dutch',
  pl: 'Polish',
  uk: 'Ukrainian',
};

export function languageDisplayName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

/**
 * L31：语言代码白名单。
 *
 * sourceLang / targetLang 原本只过一道 `readOptionalText(…, 32)` 的长度校验就被
 * 直接拼进 system prompt（`The source language is ${source}.` /
 * `Translate the user's text into ${target}.`），等于给了调用方一段 ≤32 字符的
 * **prompt 注入窗口**（"English. Ignore all previous instructions and …"）。
 * 自伤型（受害者是自己的这次翻译），但没有任何理由把它敞着。
 *
 * 判定顺序：先查已知代码表（含 `auto`），再退到严格 BCP-47 形状
 * （字母子标签、连字符分隔）——这样既挡住一切带空格/标点的注入载荷，
 * 也不会因为表里没收录某个小语种就把合法请求拒掉。
 */
const BCP47_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

export function isSupportedLanguageCode(code: string): boolean {
  if (!code) return false;
  if (code.length > 32) return false;
  if (Object.prototype.hasOwnProperty.call(LANGUAGE_NAMES, code)) return true;
  return BCP47_PATTERN.test(code);
}

/**
 * 构建句子翻译 prompt。硬约束：只输出译文本体（无引号包裹/无解释/无「译文：」前缀），
 * 保留原文的换行与列表结构，源语=auto 时自动检测。
 */
export function buildTextTranslationPrompt(
  text: string,
  sourceLang: string,
  targetLang: string
): { system: string; user: string } {
  const source = languageDisplayName(sourceLang || 'auto');
  const target = languageDisplayName(targetLang);
  const sourceClause =
    !sourceLang || sourceLang === 'auto'
      ? 'Auto-detect the source language.'
      : `The source language is ${source}.`;
  const system = [
    'You are a professional translation engine.',
    sourceClause,
    `Translate the user's text into ${target}.`,
    'Rules:',
    '- Output ONLY the translated text. No explanations, no quotes around it, no prefixes.',
    '- Preserve line breaks, lists, numbers, inline code and formatting of the original.',
    '- Keep proper nouns, technical terms and abbreviations accurate; do not localize names unless conventional.',
    '- If the text is already in the target language, refine it minimally and output it as-is.',
  ].join('\n');
  return { system, user: text };
}
