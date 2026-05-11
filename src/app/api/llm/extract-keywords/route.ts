import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { callLLM, getProviderForPurpose } from '@/lib/llm/gateway';
import {
  buildKeywordExtractionPrompt,
  buildKeywordMergePrompt,
} from '@/lib/llm/prompts';
import { extractTextFromFile } from '@/lib/fileParser';
import { enforceRateLimit } from '@/lib/rateLimit';
import { estimateTokens } from '@/lib/llm/tokenizer';
import { chunkText } from '@/lib/llm/chunking';
import { logger, serializeError } from '@/lib/logger';
import {
  LLMResponseError,
  parseKeywordExtractionResult,
} from '@/lib/llm/security';

const keywordLogger = logger.child({ component: 'extract-keywords' });
const KEYWORD_MAP_REDUCE_CONCURRENCY = 3;

/**
 * Map 阶段：每段独立调用 LLM 抽关键词。一段失败不杀整体。
 */
async function extractKeywordsFromChunks(
  chunks: ReadonlyArray<string>,
  existingKeywords: string | undefined,
  sourceType: 'transcript' | 'pptx' | 'docx' | 'pdf' | 'txt'
): Promise<string[][]> {
  const results: string[][] = new Array(chunks.length).fill(null).map(() => []);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < chunks.length) {
      const idx = cursor++;
      try {
        const system = buildKeywordExtractionPrompt(existingKeywords, sourceType);
        const raw = await callLLM(
          system,
          `Extract keywords from:\n\n${chunks[idx]}`,
          { purpose: 'KEYWORD_EXTRACTION' }
        );
        results[idx] = parseKeywordExtractionResult(raw);
      } catch (error) {
        keywordLogger.warn(
          { chunkIndex: idx, err: serializeError(error) },
          '关键词段提取失败，该段视为空'
        );
        results[idx] = [];
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(KEYWORD_MAP_REDUCE_CONCURRENCY, chunks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

/**
 * Reduce 阶段：把多段关键词列表用 LLM 合并/去重。如果合并失败就走"字面去重"兜底。
 */
async function mergeKeywordLists(
  lists: ReadonlyArray<ReadonlyArray<string>>,
  existingKeywords?: string
): Promise<string[]> {
  // 先字面去重，把规模缩到 LLM 友好的大小
  const seen = new Set<string>();
  const flat: string[] = [];
  for (const list of lists) {
    for (const kw of list) {
      const norm = kw.trim().toLowerCase();
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      flat.push(kw.trim());
    }
  }

  // 单段或无需合并：直接返回去重结果
  if (lists.length <= 1 || flat.length <= 30) {
    return flat.slice(0, 100);
  }

  try {
    const serialized = lists
      .map((list, i) => `[CHUNK ${i + 1}]: ${list.join(', ')}`)
      .join('\n');
    const prompt = buildKeywordMergePrompt(serialized, existingKeywords);
    const raw = await callLLM(prompt, 'Merge now.', {
      purpose: 'KEYWORD_EXTRACTION',
    });
    return parseKeywordExtractionResult(raw);
  } catch (error) {
    keywordLogger.warn(
      { err: serializeError(error) },
      '关键词合并 LLM 调用失败，回退到字面去重'
    );
    return flat.slice(0, 100);
  }
}

export async function POST(req: Request) {
  const rateLimited = await enforceRateLimit(req, {
    scope: 'llm:extract-keywords',
    limit: 20,
    windowMs: 60_000,
  });
  if (rateLimited) {
    return rateLimited;
  }

  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const textInput = formData.get('text') as string | null;
    const existingKeywords = formData.get('existingKeywords') as string | null;

    let sourceText = '';

    if (file) {
      // 安全检查：文件类型白名单
      const allowedTypes = [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
      ];
      if (!allowedTypes.includes(file.type)) {
        return NextResponse.json(
          { error: 'Unsupported file type' },
          { status: 400 }
        );
      }

      // 文件大小限制 (50MB)
      if (file.size > 50 * 1024 * 1024) {
        return NextResponse.json(
          { error: 'File too large (max 50MB)' },
          { status: 400 }
        );
      }

      sourceText = await extractTextFromFile(file);
    } else if (textInput) {
      sourceText = textInput;
    } else {
      return NextResponse.json(
        { error: 'No input provided' },
        { status: 400 }
      );
    }

    // 决定走单次还是 map-reduce：先看 transcript token 数和模型预算
    const provider = await getProviderForPurpose('KEYWORD_EXTRACTION').catch(
      () => null
    );
    // 关键词提取 prompt 较短（~500 token system），输出 100 关键词约 1500 token，
    // 留 0.8 安全冗余后 transcript 大约能塞 contextWindow*0.8 - 2000 token
    const inputBudget = provider
      ? Math.max(3000, Math.floor(provider.contextWindow * 0.8) - 2000)
      : 6000;
    const sourceTokens = estimateTokens(sourceText);

    let keywords: string[];

    if (sourceTokens <= inputBudget) {
      // 单次调用足以覆盖
      const system = buildKeywordExtractionPrompt(
        existingKeywords ?? undefined
      );
      const result = await callLLM(
        system,
        `Extract keywords from:\n\n${sourceText}`,
        { purpose: 'KEYWORD_EXTRACTION' }
      );
      keywords = parseKeywordExtractionResult(result);
    } else {
      // Map-reduce：按段独立提取后合并去重
      const chunks = chunkText(sourceText, {
        chunkTargetTokens: Math.min(2500, Math.floor(inputBudget * 0.6)),
      });
      keywordLogger.info(
        {
          sourceTokens,
          inputBudget,
          chunkCount: chunks.length,
        },
        '关键词提取走 map-reduce'
      );

      const chunkResults = await extractKeywordsFromChunks(
        chunks.map((c) => c.text),
        existingKeywords ?? undefined,
        'transcript'
      );
      keywords = await mergeKeywordLists(
        chunkResults,
        existingKeywords ?? undefined
      );
    }

    return NextResponse.json({ keywords });
  } catch (error) {
    if (error instanceof LLMResponseError) {
      return NextResponse.json(
        { error: 'Invalid LLM response format' },
        { status: 502 }
      );
    }

    keywordLogger.error(
      { err: serializeError(error) },
      'Extract keywords 失败'
    );
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
