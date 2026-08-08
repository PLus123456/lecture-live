import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { callLLM, getProviderForPurpose } from '@/lib/llm/gateway';
import {
  buildKeywordExtractionPrompt,
  buildKeywordMergePrompt,
  type KeywordSourceType,
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

// P4-2：输入字符上限。
// `text` 分支此前**零长度校验**（50MiB 上限只约束 `file` 分支），真上限是 Next 的 32MB 且是
// 静默截断而非拒绝 → 约 3200 块 × (一次 callLLM + 一次 merge)，而 gateway 全程不扣用户配额、
// 不动钱包，成本 100% 落在平台厂商 key 上。
// 40 万字符 ≈ 4 小时讲座转录的两倍，合法用法有充足余量。
const MAX_KEYWORD_SOURCE_CHARS = 400_000;

// P4-2：map 阶段的块数硬顶 = 单请求 LLM 调用次数硬顶。
const MAX_KEYWORD_CHUNKS = 60;

/**
 * 上传文件 MIME → KeywordSourceType 映射。之前恒用 'transcript'，导致 PPTX/DOCX/PDF/TXT
 * 都套用转录稿 prompt 提示、prompts.ts 里的按类型分支成了死代码（v3 finding U53）。
 * 未命中（如纯文本输入框）回落 'transcript'。
 */
function mimeToKeywordSourceType(mime: string): KeywordSourceType {
  switch (mime) {
    case 'application/pdf':
      return 'pdf';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return 'pptx';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    case 'text/plain':
      return 'txt';
    default:
      return 'transcript';
  }
}

/**
 * Map 阶段：每段独立调用 LLM 抽关键词。一段失败不杀整体。
 */
async function extractKeywordsFromChunks(
  chunks: ReadonlyArray<string>,
  existingKeywords: string | undefined,
  sourceType: KeywordSourceType
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
  // P4-2：先认证再限流，且按用户分桶。
  // 旧顺序（限流在前、无 key）走的是 IP 桶，而 TRUSTED_PROXY 缺省时 resolveRequestClientIp
  // 恒返回 'unknown' → 全站共用一个 20/分钟的桶：任何一个用户跑满就把所有人锁死（DoS）。
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceRateLimit(req, {
    scope: 'llm:extract-keywords',
    limit: 20,
    windowMs: 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const textInput = formData.get('text') as string | null;
    const existingKeywords = formData.get('existingKeywords') as string | null;

    let sourceText = '';
    // 默认 transcript（纯文本输入框场景）；上传文件时按 MIME 推导实际类型。
    let sourceType: KeywordSourceType = 'transcript';

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

      sourceType = mimeToKeywordSourceType(file.type);
      sourceText = await extractTextFromFile(file);
      // P4-2：抽出的正文同样要封顶（50MB 的 PPTX/PDF 能解出几 MB 文本）。文件分支已过大小闸，
      // 这里截断而非 400，避免把「体积合法只是话多」的文档整份拒掉。
      if (sourceText.length > MAX_KEYWORD_SOURCE_CHARS) {
        keywordLogger.warn(
          { chars: sourceText.length, limit: MAX_KEYWORD_SOURCE_CHARS },
          '上传文件正文超长，截断后再抽关键词'
        );
        sourceText = sourceText.slice(0, MAX_KEYWORD_SOURCE_CHARS);
      }
    } else if (textInput) {
      // P4-2：`text` 分支直接拒 —— 长度完全由客户端控制，截断只会掩盖问题。
      if (textInput.length > MAX_KEYWORD_SOURCE_CHARS) {
        return NextResponse.json(
          {
            error: `Text too long (max ${MAX_KEYWORD_SOURCE_CHARS} characters)`,
            maxChars: MAX_KEYWORD_SOURCE_CHARS,
          },
          { status: 413 }
        );
      }
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
        existingKeywords ?? undefined,
        sourceType
      );
      const result = await callLLM(
        system,
        `Extract keywords from:\n\n${sourceText}`,
        { purpose: 'KEYWORD_EXTRACTION' }
      );
      keywords = parseKeywordExtractionResult(result);
    } else {
      // Map-reduce：按段独立提取后合并去重
      // P4-2：块数封顶 —— 每块一次 callLLM，块数就是单请求的 LLM 扇出倍数。
      const chunks = chunkText(sourceText, {
        chunkTargetTokens: Math.min(2500, Math.floor(inputBudget * 0.6)),
        maxChunks: MAX_KEYWORD_CHUNKS,
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
        sourceType
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
