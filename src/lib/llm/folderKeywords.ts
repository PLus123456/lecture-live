// src/lib/llm/folderKeywords.ts
// v2.1 §D.3: Extract keywords from completed session transcript and accumulate into folder pool

import { prisma } from '@/lib/prisma';

interface ExtractedKeyword {
  keyword: string;
  confidence: number;
}

/**
 * After a recording ends, extract keywords from the full transcript
 * and add new ones to the folder's keyword pool.
 */
export async function extractAndAccumulateKeywords(
  sessionId: string,
  folderId: string,
  fullTranscript: string,
  callLLM: (system: string, user: string) => Promise<string>
): Promise<string[]> {
  const transcript = fullTranscript.trim();
  if (!transcript) {
    return [];
  }

  const sessionSource = `auto:${sessionId}`;
  const existingSessionKeywords = await prisma.folderKeyword.count({
    where: { folderId, source: sessionSource },
  });
  if (existingSessionKeywords > 0) {
    return [];
  }

  // Get existing folder keywords
  const existingKeywords = await prisma.folderKeyword.findMany({
    where: { folderId },
    select: { id: true, keyword: true, confidence: true, usageCount: true },
  });
  const existingMap = new Map(
    existingKeywords.map((entry) => [
      normalizeKeyword(entry.keyword),
      entry,
    ])
  );

  // LLM extract new keywords
  const system = `You are a keyword extraction assistant for a speech recognition system.
From the lecture transcript, extract domain-specific terms that would help future
speech recognition in the same course.

ALREADY KNOWN KEYWORDS (do not repeat):
${existingKeywords.map((entry) => entry.keyword).join(', ')}

OUTPUT FORMAT (JSON, no fences):
[
  { "keyword": "term", "confidence": 0.9 },
  ...
]

Rules:
- Extract 5-20 NEW keywords not already in the known list
- Focus on: course-specific terms, proper nouns, formulas, acronyms
- confidence: how likely this term will appear again in future lectures (0.0-1.0)
- Higher confidence for: recurring concepts, course fundamentals, professor names
- Lower confidence for: one-off examples, tangential mentions`;

  const result = await callLLM(system, `Transcript:\n${transcript.slice(0, 10000)}`);

  // L35：LLM 返回体必须当**不可信输入**校验。此前只 try/catch 了 JSON.parse：
  //  - 返回一个 JSON 对象（非数组）→ `for...of` 抛未捕获 TypeError；
  //  - 元素不是对象 / keyword 非字符串 → normalizeKeyword 里 .trim() 抛 TypeError；
  //  - confidence 是字符串 "high" → `"high" || 0` = "high" → Math.min/max 得 NaN
  //    → Prisma 写入抛错，而且是在**循环中途**：前面的关键词已经写库、后面的全丢，
  //    留下一个半截状态（同目录 security.ts 早有完整的 toStringArray/toBounded 防御）。
  const newKeywords = parseExtractedKeywords(result);
  if (newKeywords.length === 0) {
    return [];
  }

  // Write to database (deduplicate)
  const added: string[] = [];
  for (const kw of newKeywords) {
    const normalizedKeyword = normalizeKeyword(kw.keyword);
    if (!normalizedKeyword) {
      continue;
    }

    const confidence = kw.confidence;
    const existing = existingMap.get(normalizedKeyword);

    if (existing) {
      await prisma.folderKeyword.update({
        where: { id: existing.id },
        data: {
          confidence: Math.max(existing.confidence, confidence),
          usageCount: existing.usageCount + 1,
        },
      });
      continue;
    }

    try {
      const created = await prisma.folderKeyword.create({
        data: {
          folderId,
          keyword: normalizedKeyword,
          source: sessionSource,
          confidence,
          usageCount: 1,
        },
      });
      existingMap.set(normalizedKeyword, {
        id: created.id,
        keyword: normalizedKeyword,
        confidence,
        usageCount: 1,
      });
      added.push(normalizedKeyword);
    } catch {
      // unique constraint violation — keyword already exists, skip
    }
  }

  return added;
}

/**
 * Get all keywords for a folder, sorted by confidence descending
 */
export async function getFolderKeywords(folderId: string) {
  return prisma.folderKeyword.findMany({
    where: { folderId },
    orderBy: { confidence: 'desc' },
  });
}

/**
 * Add a manual keyword to a folder
 */
export async function addManualKeyword(folderId: string, keyword: string) {
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedKeyword) {
    throw new Error('Keyword is required');
  }

  return prisma.folderKeyword.upsert({
    where: { folderId_keyword: { folderId, keyword: normalizedKeyword } },
    update: { confidence: 1.0, source: 'manual' },
    create: {
      folderId,
      keyword: normalizedKeyword,
      source: 'manual',
      confidence: 1.0,
    },
  });
}

/**
 * Remove a keyword from a folder
 */
export async function removeKeyword(folderId: string, keyword: string) {
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedKeyword) {
    return { count: 0 };
  }

  return prisma.folderKeyword.deleteMany({
    where: { folderId, keyword: normalizedKeyword },
  });
}

function normalizeKeyword(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 120);
}

/** 单次提取最多接受多少个关键词（防模型吐出超长数组打爆写库循环） */
const MAX_EXTRACTED_KEYWORDS = 200;

/**
 * L35：把 LLM 的原始响应解析成**保证形状正确**的关键词数组。
 * 任何解析/类型问题都降级成"这次不加关键词"，而不是抛错炸掉调用它的收尾流程。
 *
 * 导出仅供单测；生产只走 extractAndAccumulateKeywords。
 */
export function parseExtractedKeywords(raw: string): ExtractedKeyword[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    console.error('Failed to parse keyword extraction result:', raw);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.error('Keyword extraction result is not an array:', raw);
    return [];
  }

  const out: ExtractedKeyword[] = [];
  for (const entry of parsed.slice(0, MAX_EXTRACTED_KEYWORDS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { keyword, confidence } = entry as Record<string, unknown>;
    if (typeof keyword !== 'string' || !keyword.trim()) continue;
    // 非数值 confidence（含 "0.9" 字符串、null、NaN）一律按 0 处理，绝不让 NaN 进 Prisma。
    const numeric = typeof confidence === 'number' ? confidence : Number.NaN;
    const bounded = Number.isFinite(numeric)
      ? Math.max(0, Math.min(1, numeric))
      : 0;
    out.push({ keyword, confidence: bounded });
  }
  return out;
}
