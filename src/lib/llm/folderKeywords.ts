import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { callLLM, getProviderForPurpose } from '@/lib/llm/gateway';
import {
  ActiveJobConflictError,
  completeActiveJob,
  failActiveJob,
  JOB_TYPE,
} from '@/lib/jobQueue';
import {
  claimLlmTokenBudget,
  conservativeLlmCallTokens,
  trustedLlmUsageTokens,
} from '@/lib/llm/resourceBudget';
import { validateExistingKeywordItems } from '@/lib/llm/keywordPolicy';
import { sanitizePromptValue } from '@/lib/llm/security';
import { assertPaymentBenefitAvailable } from '@/lib/payment/entitlementAdmission';

const FOLDER_KEYWORD_SCHEMA_VERSION = 2;
const MAX_FOLDER_KEYWORD_PROMPT_ITEMS = 200;
const MAX_FOLDER_KEYWORD_TRANSCRIPT_CHARS = 10_000;
const MAX_FOLDER_KEYWORD_OPERATION_TOKENS = 100_000;

interface ExtractedKeyword {
  keyword: string;
  confidence: number;
}

interface ExistingFolderKeyword {
  id: string;
  keyword: string;
  confidence: number;
  usageCount: number;
}

function boundedPromptKeywords(
  entries: ReadonlyArray<ExistingFolderKeyword>
): string[] {
  let selected: string[] = [];
  for (const entry of entries.slice(0, MAX_FOLDER_KEYWORD_PROMPT_ITEMS)) {
    const candidate = [...selected, entry.keyword];
    const validation = validateExistingKeywordItems(candidate);
    if (validation.ok) selected = validation.keywords;
  }
  return selected;
}

function folderKeywordSourceHash(options: {
  sessionId: string;
  folderId: string;
  transcript: string;
  modelKey: string;
  maxOutputTokens: number;
}): string {
  return crypto
    .createHash('sha256')
    .update(`folder-keywords-v${FOLDER_KEYWORD_SCHEMA_VERSION}\0`)
    .update(options.sessionId)
    .update('\0')
    .update(options.folderId)
    .update('\0')
    .update(options.modelKey)
    .update('\0')
    .update(String(options.maxOutputTokens))
    .update('\0')
    .update(options.transcript)
    .digest('hex');
}

async function readFolderKeywordMarker(
  sessionId: string,
  folderId: string
): Promise<{ exists: boolean; sourceHash: string | null }> {
  const rows = await prisma.$queryRaw<Array<{ sourceHash: string | null }>>(
    Prisma.sql`SELECT folderKeywordSourceHash AS sourceHash
               FROM FolderSession
               WHERE folderId = ${folderId} AND sessionId = ${sessionId}
               LIMIT 1`
  );
  return rows.length === 1
    ? { exists: true, sourceHash: rows[0].sourceHash }
    : { exists: false, sourceHash: null };
}

async function compareAndSetFolderKeywordMarker(options: {
  sessionId: string;
  folderId: string;
  expectedSourceHash: string | null;
  nextSourceHash: string;
}): Promise<boolean> {
  const expected =
    options.expectedSourceHash === null
      ? Prisma.sql`folderKeywordSourceHash IS NULL`
      : Prisma.sql`folderKeywordSourceHash = ${options.expectedSourceHash}`;
  const updated = await prisma.$executeRaw(
    Prisma.sql`UPDATE FolderSession
               SET folderKeywordSourceHash = ${options.nextSourceHash},
                   folderKeywordGeneratedAt = UTC_TIMESTAMP(3)
               WHERE folderId = ${options.folderId}
                 AND sessionId = ${options.sessionId}
                 AND ${expected}`
  );
  return updated === 1;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * After a recording ends, extract keywords from the full transcript
 * and add new ones to the folder's keyword pool.
 */
export async function extractAndAccumulateKeywords(
  sessionId: string,
  folderId: string,
  userId: string,
  fullTranscript: string
): Promise<string[]> {
  const transcript = fullTranscript.trim();
  if (!transcript) {
    return [];
  }
  await assertPaymentBenefitAvailable(userId);

  const provider = await getProviderForPurpose('KEYWORD_EXTRACTION');
  if (!Number.isSafeInteger(provider.maxTokens) || provider.maxTokens <= 0) {
    throw new Error('Folder keyword model has an invalid output limit');
  }
  const transcriptForPrompt = transcript.slice(
    0,
    MAX_FOLDER_KEYWORD_TRANSCRIPT_CHARS
  );
  const modelKey = provider.dbModelId ?? `${provider.name}:${provider.model}`;
  const sourceHash = folderKeywordSourceHash({
    sessionId,
    folderId,
    transcript: transcriptForPrompt,
    modelKey,
    maxOutputTokens: provider.maxTokens,
  });
  const marker = await readFolderKeywordMarker(sessionId, folderId);
  if (!marker.exists) return [];
  if (marker.sourceHash === sourceHash) return [];
  const initialMarkerHash = marker.sourceHash;

  const sessionSource = `auto:${sessionId}`;
  const existingKeywords = await prisma.folderKeyword.findMany({
    where: { folderId },
    select: { id: true, keyword: true, confidence: true, usageCount: true },
    orderBy: [{ confidence: 'desc' }, { createdAt: 'asc' }],
    take: MAX_FOLDER_KEYWORD_PROMPT_ITEMS,
  });
  const existingMap = new Map(
    existingKeywords.map((entry) => [
      normalizeKeyword(entry.keyword),
      entry,
    ])
  );
  const knownForPrompt = boundedPromptKeywords(existingKeywords);

  const system = `You are a keyword extraction assistant for a speech recognition system.
From the lecture transcript, extract domain-specific terms that would help future
speech recognition in the same course.

ALREADY KNOWN KEYWORDS (do not repeat):
${JSON.stringify(knownForPrompt.map(sanitizePromptValue))}

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
  const userMessage = `Transcript:\n${sanitizePromptValue(transcriptForPrompt)}`;
  const reservedTokens = conservativeLlmCallTokens(
    system,
    userMessage,
    provider.maxTokens
  );
  if (reservedTokens > MAX_FOLDER_KEYWORD_OPERATION_TOKENS) {
    throw new Error('Folder keyword extraction token budget exceeded');
  }

  let jobId: string;
  try {
    jobId = await claimLlmTokenBudget({
      type: JOB_TYPE.KEYWORD_EXTRACTION,
      sessionId,
      userId,
      triggeredBy: 'system',
      activeKey: `folder_keywords:${sessionId}:${folderId}`,
      units: reservedTokens,
      params: {
        folderId,
        sourceHash,
        schemaVersion: FOLDER_KEYWORD_SCHEMA_VERSION,
        reservedTokens,
      },
    });
  } catch (error) {
    if (!(error instanceof ActiveJobConflictError)) throw error;
    return [];
  }

  let actualTokens = 0;
  let providerMeasuredCalls = 0;
  let conservativeFallbackCalls = 0;
  let successSettlementStarted = false;
  try {
    // 闭合初读 marker miss → winner 完成并释放 activeKey → loser claim 的间隙。
    const afterClaimMarker = await readFolderKeywordMarker(sessionId, folderId);
    if (!afterClaimMarker.exists) {
      throw new Error('Session is no longer attached to folder');
    }
    if (afterClaimMarker.sourceHash === sourceHash) {
      successSettlementStarted = true;
      await completeActiveJob(
        jobId,
        { folderId, sourceHash, reusedAfterClaim: true, actualTokens: 0 },
        0
      );
      return [];
    }
    if (afterClaimMarker.sourceHash !== initialMarkerHash) {
      throw new Error(
        'Folder keyword source changed while waiting for generation claim'
      );
    }

    if (initialMarkerHash === null) {
      // 升级前只有正结果通过 source 行充当哨兵。也必须在取得 activeKey 后回填，
      // 否则无 claim 的 backfill 会与正在运行的旧/新版本互相覆盖 marker。
      const legacyResultCount = await prisma.folderKeyword.count({
        where: { folderId, source: sessionSource },
      });
      if (legacyResultCount > 0) {
        const marked = await compareAndSetFolderKeywordMarker({
          sessionId,
          folderId,
          expectedSourceHash: initialMarkerHash,
          nextSourceHash: sourceHash,
        });
        if (!marked) {
          throw new Error('Folder keyword source changed during legacy backfill');
        }
        successSettlementStarted = true;
        await completeActiveJob(
          jobId,
          { folderId, sourceHash, legacyMarkerBackfill: true, actualTokens: 0 },
          0
        );
        return [];
      }
    }

    let measured: number | null = null;
    let result: string;
    try {
      result = await callLLM(system, userMessage, {
        purpose: 'KEYWORD_EXTRACTION',
        maxOutputTokens: provider.maxTokens,
        onUsage: (usage) => {
          measured = trustedLlmUsageTokens(usage, reservedTokens);
        },
      });
    } catch (error) {
      actualTokens = reservedTokens;
      conservativeFallbackCalls = 1;
      throw error;
    }
    actualTokens = measured ?? reservedTokens;
    if (measured === null) conservativeFallbackCalls = 1;
    else providerMeasuredCalls = 1;

    const newKeywords = parseExtractedKeywords(result);
    const added: string[] = [];
    for (const kw of newKeywords) {
      const normalizedKeyword = normalizeKeyword(kw.keyword);
      if (!normalizedKeyword) continue;

      const confidence = Math.max(0, Math.min(1, kw.confidence));
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
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
      }
    }

    // 空数组同样是有效否定：marker 必须落地，否则每次保存都会再次付费。
    const marked = await compareAndSetFolderKeywordMarker({
      sessionId,
      folderId,
      expectedSourceHash: initialMarkerHash,
      nextSourceHash: sourceHash,
    });
    if (!marked) {
      throw new Error('Folder keyword source changed before marker publish');
    }

    successSettlementStarted = true;
    await completeActiveJob(
      jobId,
      {
        folderId,
        sourceHash,
        reservedTokens,
        actualTokens,
        providerMeasuredCalls,
        conservativeFallbackCalls,
        keywordCount: added.length,
      },
      actualTokens
    );
    return added;
  } catch (error) {
    if (!successSettlementStarted) {
      await failActiveJob(
        jobId,
        error,
        {
          folderId,
          sourceHash,
          reservedTokens,
          actualTokens,
          providerMeasuredCalls,
          conservativeFallbackCalls,
        },
        actualTokens
      ).catch(() => undefined);
    }
    throw error;
  }
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
  return Array.from(value.trim().replace(/\s+/gu, ' ')).slice(0, 120).join('');
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
