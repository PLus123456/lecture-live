interface FolderKeywordRecord {
  keyword: string;
  confidence?: number | null;
}

interface WeightedKeywordSource {
  keywords: string[];
  weight: number;
}

const DEFAULT_WEIGHTS = {
  folder: 0.4,
  session: 0.3,
  file: 0.3,
} as const;

const MAX_TERMS_CHARS = 6000;

function normalizeKeyword(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 120);
}

function dedupeKeywords(keywords: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  keywords.forEach((keyword) => {
    const normalized = normalizeKeyword(keyword);
    if (!normalized) {
      return;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    merged.push(normalized);
  });

  return merged;
}

function appendWithinBudget(
  target: string[],
  seen: Set<string>,
  source: WeightedKeywordSource,
  totalBudget: number,
  totalState: { used: number }
) {
  const sourceBudget = Math.floor(totalBudget * source.weight);
  let sourceUsed = 0;

  for (const keyword of source.keywords) {
    const normalized = normalizeKeyword(keyword);
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    const cost = normalized.length + 2;
    if (sourceUsed + cost > sourceBudget || totalState.used + cost > totalBudget) {
      continue;
    }

    seen.add(key);
    target.push(normalized);
    sourceUsed += cost;
    totalState.used += cost;
  }
}

function normalizeSources(
  sources: WeightedKeywordSource[]
): WeightedKeywordSource[] {
  const activeSources = sources.filter((source) => source.keywords.length > 0);
  const totalWeight = activeSources.reduce((sum, source) => sum + source.weight, 0);

  if (activeSources.length === 0 || totalWeight <= 0) {
    return [];
  }

  return activeSources.map((source) => ({
    ...source,
    weight: source.weight / totalWeight,
  }));
}

export function mergeSessionTerms(options: {
  folderKeywords?: FolderKeywordRecord[];
  sessionKeywords?: string[];
  fileKeywords?: string[];
}): string[] {
  const folderKeywords = [...(options.folderKeywords ?? [])]
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .map((entry) => entry.keyword);
  const sessionKeywords = dedupeKeywords(options.sessionKeywords ?? []);
  const fileKeywords = dedupeKeywords(options.fileKeywords ?? []);

  const merged: string[] = [];
  const seen = new Set<string>();
  const totalState = { used: 0 };
  const sources = normalizeSources([
    { keywords: folderKeywords, weight: DEFAULT_WEIGHTS.folder },
    { keywords: sessionKeywords, weight: DEFAULT_WEIGHTS.session },
    { keywords: fileKeywords, weight: DEFAULT_WEIGHTS.file },
  ]);

  sources.forEach((source) => {
    appendWithinBudget(
      merged,
      seen,
      source,
      MAX_TERMS_CHARS,
      totalState
    );
  });

  if (merged.length > 0) {
    return merged;
  }

  return dedupeKeywords([
    ...folderKeywords,
    ...sessionKeywords,
    ...fileKeywords,
  ]);
}

export async function resolveSessionTerms(options: {
  token: string;
  folderId?: string | null;
  sessionKeywords?: string[];
  fileKeywords?: string[];
}): Promise<string[]> {
  const sessionKeywords = options.sessionKeywords ?? [];
  const fileKeywords = options.fileKeywords ?? [];

  if (!options.folderId) {
    return mergeSessionTerms({ sessionKeywords, fileKeywords });
  }

  try {
    const response = await fetch(`/api/folders/${options.folderId}/keywords`, {
      headers: { Authorization: `Bearer ${options.token}` },
    });

    if (!response.ok) {
      return mergeSessionTerms({ sessionKeywords, fileKeywords });
    }

    const data = await response.json().catch(() => []);
    const folderKeywords = Array.isArray(data)
      ? data
          .filter(
            (entry): entry is FolderKeywordRecord =>
              Boolean(entry) &&
              typeof entry === 'object' &&
              typeof entry.keyword === 'string'
          )
      : [];

    return mergeSessionTerms({
      folderKeywords,
      sessionKeywords,
      fileKeywords,
    });
  } catch {
    return mergeSessionTerms({ sessionKeywords, fileKeywords });
  }
}
