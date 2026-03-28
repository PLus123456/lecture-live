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

  let newKeywords: ExtractedKeyword[];
  try {
    newKeywords = JSON.parse(result.replace(/```json|```/g, '').trim());
  } catch {
    console.error('Failed to parse keyword extraction result:', result);
    return [];
  }

  // Write to database (deduplicate)
  const added: string[] = [];
  for (const kw of newKeywords) {
    const normalizedKeyword = normalizeKeyword(kw.keyword);
    if (!normalizedKeyword) {
      continue;
    }

    const confidence = Math.max(0, Math.min(1, kw.confidence || 0));
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
