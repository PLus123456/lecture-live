// src/lib/soniox/keywordMerger.ts
// v2.1 §D.4: Merge keywords from 3 sources with weighted budget allocation

import { prisma } from '@/lib/prisma';

interface KeywordSource {
  keywords: string[];
  source: 'folder' | 'session_llm' | 'uploaded_file';
  weight: number;
}

const DEFAULT_WEIGHTS = {
  folder: parseFloat(process.env.KEYWORD_WEIGHT_FOLDER || '0.4'),
  session_llm: parseFloat(process.env.KEYWORD_WEIGHT_SESSION_LLM || '0.3'),
  uploaded_file: parseFloat(process.env.KEYWORD_WEIGHT_UPLOADED_FILE || '0.3'),
};

// Soniox context.terms safe limit (leave room for general context)
const MAX_TERMS_CHARS = 6000;

/**
 * Merge keywords from multiple sources respecting per-source weight budgets.
 * Returns a deduplicated list of keywords fitting within MAX_TERMS_CHARS.
 */
export function mergeKeywords(sources: KeywordSource[]): string[] {
  const totalBudget = MAX_TERMS_CHARS;
  const merged: string[] = [];
  let usedChars = 0;

  const activeSources = sources.filter((source) => source.keywords.length > 0);
  const totalWeight = activeSources.reduce((sum, source) => sum + source.weight, 0);
  const normalizedSources = totalWeight > 0
    ? activeSources.map((source) => ({
        ...source,
        weight: source.weight / totalWeight,
      }))
    : [];

  // Sort by weight descending so highest-priority source fills first
  const sorted = normalizedSources.sort((a, b) => b.weight - a.weight);

  for (const source of sorted) {
    const budgetForSource = totalBudget * source.weight;
    let sourceChars = 0;

    for (const kw of source.keywords) {
      if (sourceChars + kw.length > budgetForSource) break;
      if (usedChars + kw.length > totalBudget) break;
      if (!merged.includes(kw)) {
        merged.push(kw);
        sourceChars += kw.length + 2; // +2 for separator
        usedChars += kw.length + 2;
      }
    }
  }

  return merged;
}

/**
 * Build the full Soniox context.terms for a new session in a given folder.
 * Combines: folder keyword pool + session LLM keywords + uploaded file keywords
 */
export async function buildSessionTerms(
  folderId: string | null,
  sessionKeywords: string[],
  fileKeywords: string[]
): Promise<string[]> {
  let folderKws: string[] = [];

  if (folderId) {
    const rows = await prisma.folderKeyword.findMany({
      where: { folderId },
      orderBy: { confidence: 'desc' },
    });
    folderKws = rows.map((k) => k.keyword);
  }

  return mergeKeywords([
    { keywords: folderKws, source: 'folder', weight: DEFAULT_WEIGHTS.folder },
    { keywords: sessionKeywords, source: 'session_llm', weight: DEFAULT_WEIGHTS.session_llm },
    { keywords: fileKeywords, source: 'uploaded_file', weight: DEFAULT_WEIGHTS.uploaded_file },
  ]);
}
