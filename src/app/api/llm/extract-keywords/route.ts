import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { isPaymentBenefitAvailable } from '@/lib/payment/entitlementAdmission';
import { callLLM, getProviderForPurpose } from '@/lib/llm/gateway';
import {
  buildKeywordExtractionPrompt,
  buildKeywordMergePrompt,
  type KeywordSourceType,
} from '@/lib/llm/prompts';
import { extractTextFromFile } from '@/lib/fileParser';
import { DocumentParserError } from '@/lib/documentParserProcess';
import { enforceRateLimit } from '@/lib/rateLimit';
import { estimateTokens } from '@/lib/llm/tokenizer';
import { chunkText } from '@/lib/llm/chunking';
import { logger, serializeError } from '@/lib/logger';
import {
  LLMResponseError,
  parseKeywordExtractionResult,
  sanitizePromptValue,
} from '@/lib/llm/security';
import {
  normalizeKeywordKey,
  parseExistingKeywordText,
  keywordUtf8ByteLength,
  type ExistingKeywordPolicyFailure,
} from '@/lib/llm/keywordPolicy';
import {
  ActiveJobBudgetExceededError,
  completeActiveJob,
  failActiveJob,
  JOB_TYPE,
} from '@/lib/jobQueue';
import {
  claimLlmTokenBudget,
  conservativeLlmCallTokens,
  LLM_PROMPT_PROTOCOL_TOKEN_OVERHEAD,
  trustedLlmUsageTokens,
} from '@/lib/llm/resourceBudget';

const keywordLogger = logger.child({ component: 'extract-keywords' });
const KEYWORD_MAP_REDUCE_CONCURRENCY = 3;

// Reduce 最终只输出 50 条，不必把最多 60 个 map 的全部结果重新塞进一次 prompt。
const MAX_KEYWORD_REDUCE_CANDIDATES = 180;
const MAX_KEYWORD_REDUCE_SERIALIZED_BYTES = 64 * 1024;

// 一次提取的硬预算：所有 map 输入 + 每次模型最大输出 + 最坏 reduce 一并预留。
// 超限时在第一个 callLLM 之前整体拒绝，避免执行到一半才停止。
const MAX_KEYWORD_OPERATION_TOKENS = 1_000_000;

const KEYWORD_CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/gu;

class KeywordRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 503
  ) {
    super(message);
    this.name = 'KeywordRequestError';
  }
}

/**
 * FormDataEntryValue 在运行时可能是 File。这里不做强转、不截断：任一边界越界都显式拒绝。
 */
function parseExistingKeywords(value: unknown): string[] {
  if (value === null || value === undefined || value === '') {
    return [];
  }
  if (typeof value !== 'string') {
    throw new KeywordRequestError(
      'existingKeywords must be a text field',
      400
    );
  }

  const parsed = parseExistingKeywordText(value);
  if (parsed.ok) return parsed.keywords;

  const errors: Record<
    ExistingKeywordPolicyFailure,
    { message: string; status: 400 | 413 }
  > = {
    invalid_format: { message: 'existingKeywords has invalid format', status: 400 },
    too_large: { message: 'existingKeywords is too large', status: 413 },
    too_many: { message: 'Too many existingKeywords', status: 413 },
    control_characters: {
      message: 'existingKeywords contains control characters',
      status: 400,
    },
    item_too_long: { message: 'An existing keyword is too long', status: 413 },
    token_limit: {
      message: 'existingKeywords token limit exceeded',
      status: 413,
    },
  };
  const failure = errors[parsed.reason];
  throw new KeywordRequestError(failure.message, failure.status);
}

function cleanReturnedKeyword(value: string): string {
  return value
    .replace(KEYWORD_CONTROL_CHARS_GLOBAL, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

/** 本地硬过滤：不依赖模型遵守「不返回已知词」的 prompt。 */
function filterKnownKeywords(
  keywords: ReadonlyArray<string>,
  existingKeywords: ReadonlyArray<string>,
  maxItems = 100
): string[] {
  const existing = new Set(existingKeywords.map(normalizeKeywordKey));
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of keywords) {
    const keyword = cleanReturnedKeyword(value);
    const key = normalizeKeywordKey(keyword);
    if (!key || existing.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(keyword);
    if (result.length >= maxItems) break;
  }
  return result;
}

/** 轮询各 chunk 收集候选，避免 reduce 上限只保留前几段内容。 */
function collectKeywordCandidates(
  lists: ReadonlyArray<ReadonlyArray<string>>,
  existingKeywords: ReadonlyArray<string>
): string[] {
  const existing = new Set(existingKeywords.map(normalizeKeywordKey));
  const seen = new Set<string>();
  const candidates: string[] = [];
  const maxDepth = lists.reduce((max, list) => Math.max(max, list.length), 0);

  outer: for (let itemIndex = 0; itemIndex < maxDepth; itemIndex += 1) {
    for (const list of lists) {
      const value = list[itemIndex];
      if (typeof value !== 'string') continue;
      const keyword = cleanReturnedKeyword(value);
      const key = normalizeKeywordKey(keyword);
      if (!key || existing.has(key) || seen.has(key)) continue;
      seen.add(key);
      candidates.push(keyword);
      if (candidates.length >= MAX_KEYWORD_REDUCE_CANDIDATES) {
        break outer;
      }
    }
  }
  return candidates;
}

/** 产出一个字节数确定有界的 JSON 数据块，供 reduce prompt 使用。 */
function serializeKeywordCandidates(keywords: ReadonlyArray<string>): string {
  const parts: string[] = [];
  let bytes = 2; // []
  for (const keyword of keywords) {
    // 先做与 wrapPromptBlock 相同的标签转义，使字节上限就是最终 prompt 的实际上限，
    // 也防止模型返回的 `</candidate_keyword_lists>` 提前闭合数据块。
    const encoded = JSON.stringify(sanitizePromptValue(keyword));
    const nextBytes = keywordUtf8ByteLength(encoded) + (parts.length > 0 ? 1 : 0);
    if (bytes + nextBytes > MAX_KEYWORD_REDUCE_SERIALIZED_BYTES) break;
    parts.push(encoded);
    bytes += nextBytes;
  }
  return `[${parts.join(',')}]`;
}

interface KeywordCallPlan {
  system: string;
  user: string;
}

/**
 * 将整批可能的付费调用一次性纳入预算。Reduce 结果在 map 前尚不可知，
 * 因此用「有界序列化字节数」作为它的保守 token 上界（BPE token 数不会超过 UTF-8 字节数）。
 */
function assertKeywordOperationBudget(
  plans: ReadonlyArray<KeywordCallPlan>,
  providerMaxOutputTokens: number,
  existingKeywords: ReadonlyArray<string>,
  includePossibleReduce: boolean
): number {
  if (
    !Number.isSafeInteger(providerMaxOutputTokens) ||
    providerMaxOutputTokens <= 0
  ) {
    throw new KeywordRequestError(
      'Keyword extraction model has an invalid output limit',
      503
    );
  }

  let reservedTokens = 0;
  for (const plan of plans) {
    // UTF-8 字节数是任意字节级 BPE 输入 token 数的确定上界；不能只用本地
    // cl100k 估算，否则更换供应商 tokenizer 后所谓「最坏预留」仍可能低估。
    reservedTokens +=
      keywordUtf8ByteLength(plan.system) +
      keywordUtf8ByteLength(plan.user) +
      LLM_PROMPT_PROTOCOL_TOKEN_OVERHEAD +
      providerMaxOutputTokens;
    if (reservedTokens > MAX_KEYWORD_OPERATION_TOKENS) {
      keywordLogger.warn(
        { reservedTokens, maxOperationTokens: MAX_KEYWORD_OPERATION_TOKENS },
        '关键词整批 LLM 调用预算超限'
      );
      throw new KeywordRequestError(
        'Keyword extraction token budget exceeded',
        413
      );
    }
  }

  if (includePossibleReduce) {
    // 已知词块用实际内容构造；未知的 map 结果按序列化硬上限全额预留。
    const reduceBase = buildKeywordMergePrompt('', existingKeywords);
    reservedTokens +=
      keywordUtf8ByteLength(reduceBase) +
      MAX_KEYWORD_REDUCE_SERIALIZED_BYTES +
      LLM_PROMPT_PROTOCOL_TOKEN_OVERHEAD +
      providerMaxOutputTokens;
  }

  if (reservedTokens > MAX_KEYWORD_OPERATION_TOKENS) {
    keywordLogger.warn(
      { reservedTokens, maxOperationTokens: MAX_KEYWORD_OPERATION_TOKENS },
      '关键词整批 LLM 调用预算超限'
    );
    throw new KeywordRequestError(
      'Keyword extraction token budget exceeded',
      413
    );
  }
  return reservedTokens;
}

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
  systemPrompt: string,
  callKeywordLLM: (system: string, user: string) => Promise<string>
): Promise<string[][]> {
  const results: string[][] = new Array(chunks.length).fill(null).map(() => []);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < chunks.length) {
      const idx = cursor++;
      try {
        const raw = await callKeywordLLM(
          systemPrompt,
          `Extract keywords from:\n\n${chunks[idx]}`
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
  existingKeywords: ReadonlyArray<string>,
  callKeywordLLM: (system: string, user: string) => Promise<string>
): Promise<string[]> {
  // 先在本地过滤已知词并去重；该结果同时覆盖所有提前返回和 LLM 失败回退分支。
  const flat = collectKeywordCandidates(lists, existingKeywords);

  // 单段或无需合并：直接返回去重结果
  if (lists.length <= 1 || flat.length <= 30) {
    return flat.slice(0, 100);
  }

  try {
    const serialized = serializeKeywordCandidates(flat);
    const prompt = buildKeywordMergePrompt(serialized, existingKeywords);
    const raw = await callKeywordLLM(prompt, 'Merge now.');
    return filterKnownKeywords(
      parseKeywordExtractionResult(raw),
      existingKeywords
    );
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
  if (!(await isPaymentBenefitAvailable(user.id))) {
    return NextResponse.json(
      { error: '账户存在未处理的支付争议', code: 'payment_account_frozen' },
      { status: 403 }
    );
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
    const existingKeywords = parseExistingKeywords(
      formData.get('existingKeywords')
    );

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
      sourceText = await extractTextFromFile(file, { signal: req.signal });
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
    const provider = await getProviderForPurpose('KEYWORD_EXTRACTION');
    if (
      !Number.isSafeInteger(provider.contextWindow) ||
      provider.contextWindow <= 0
    ) {
      throw new KeywordRequestError(
        'Keyword extraction model has an invalid context window',
        503
      );
    }
    // 关键词提取 prompt 较短（~500 token system），输出 100 关键词约 1500 token，
    // 留 0.8 安全冗余后 transcript 大约能塞 contextWindow*0.8 - 2000 token
    const inputBudget = Math.max(
      3000,
      Math.floor(provider.contextWindow * 0.8) - 2000
    );
    const sourceTokens = estimateTokens(sourceText);

    let reservedTokens: number;
    let providerCallsReserved: number;
    let mapReduce: boolean;
    let executeOperation: (
      callKeywordLLM: (system: string, user: string) => Promise<string>
    ) => Promise<string[]>;

    if (sourceTokens <= inputBudget) {
      // 单次调用足以覆盖
      const system = buildKeywordExtractionPrompt(
        existingKeywords,
        sourceType
      );
      const userMessage = `Extract keywords from:\n\n${sourceText}`;
      reservedTokens = assertKeywordOperationBudget(
        [{ system, user: userMessage }],
        provider.maxTokens,
        existingKeywords,
        false
      );
      providerCallsReserved = 1;
      mapReduce = false;
      executeOperation = async (callKeywordLLM) => {
        const result = await callKeywordLLM(system, userMessage);
        return filterKnownKeywords(
          parseKeywordExtractionResult(result),
          existingKeywords
        );
      };
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

      // SEC-011：map 不带已知词，避免把同一份数据复制到最多 60 个付费 prompt。
      const mapSystem = buildKeywordExtractionPrompt([], sourceType);
      const chunkTexts = chunks.map((chunk) => chunk.text);
      reservedTokens = assertKeywordOperationBudget(
        chunkTexts.map((chunk) => ({
          system: mapSystem,
          user: `Extract keywords from:\n\n${chunk}`,
        })),
        provider.maxTokens,
        existingKeywords,
        true
      );
      keywordLogger.info(
        {
          reservedTokens,
          maxOperationTokens: MAX_KEYWORD_OPERATION_TOKENS,
        },
        '关键词整批 LLM 调用已通过预算预检'
      );
      providerCallsReserved = chunkTexts.length + 1;
      mapReduce = true;
      executeOperation = async (callKeywordLLM) => {
        const chunkResults = await extractKeywordsFromChunks(
          chunkTexts,
          mapSystem,
          callKeywordLLM
        );
        return mergeKeywordLists(
          chunkResults,
          existingKeywords,
          callKeywordLLM
        );
      };
    }

    // 与报告共享 UTC 日 token 账本；整批最坏工作量在首个 provider 调用前
    // 于 scope 行锁内原子预留，跨进程并发不能共同越过用户/全局预算。
    const jobId = await claimLlmTokenBudget({
      type: JOB_TYPE.KEYWORD_EXTRACTION,
      activeKey: `keyword:${user.id}:${randomUUID()}`,
      units: reservedTokens,
      userId: user.id,
      triggeredBy: `user:${user.id}`,
      params: {
        reservedTokens,
        providerCalls: providerCallsReserved,
        sourceChars: sourceText.length,
        mapReduce,
      },
    });

    let providerCallsStarted = 0;
    let providerMeasuredCalls = 0;
    let conservativeFallbackCalls = 0;
    let actualTokens = 0;
    let accountingInvariantFailed = false;
    const budgetedCall = async (
      system: string,
      userMessage: string
    ): Promise<string> => {
      if (
        accountingInvariantFailed ||
        providerCallsStarted >= providerCallsReserved
      ) {
        accountingInvariantFailed = true;
        actualTokens = reservedTokens;
        throw new KeywordRequestError(
          'Keyword extraction accounting invariant failed',
          503
        );
      }
      providerCallsStarted += 1;
      const callReservation = conservativeLlmCallTokens(
        system,
        userMessage,
        provider.maxTokens
      );
      let measured: number | null = null;
      let response: string | undefined;
      let callError: unknown;
      try {
        response = await callLLM(system, userMessage, {
          purpose: 'KEYWORD_EXTRACTION',
          maxOutputTokens: provider.maxTokens,
          onUsage: (usage) => {
            measured = trustedLlmUsageTokens(usage, callReservation);
          },
        });
      } catch (error) {
        callError = error;
      }

      // 上游可能在计费后断连；缺失、为零或夸大的 usage 都按本调用上界结算。
      const settledCallUnits = measured ?? callReservation;
      if (measured === null) conservativeFallbackCalls += 1;
      else providerMeasuredCalls += 1;
      const nextActualTokens = actualTokens + settledCallUnits;
      if (
        !Number.isSafeInteger(nextActualTokens) ||
        nextActualTokens > reservedTokens
      ) {
        accountingInvariantFailed = true;
        actualTokens = reservedTokens;
        throw new KeywordRequestError(
          'Keyword extraction accounting invariant failed',
          503
        );
      }
      actualTokens = nextActualTokens;
      if (callError !== undefined) throw callError;
      return response as string;
    };

    let keywords: string[];
    try {
      keywords = await executeOperation(budgetedCall);
      if (accountingInvariantFailed) {
        throw new KeywordRequestError(
          'Keyword extraction accounting invariant failed',
          503
        );
      }
    } catch (error) {
      await failActiveJob(
        jobId,
        error,
        {
          reservedTokens,
          actualTokens,
          providerCallsStarted,
          providerMeasuredCalls,
          conservativeFallbackCalls,
        },
        actualTokens
      ).catch((jobError) => {
        keywordLogger.error(
          { jobId, err: serializeError(jobError) },
          '关键词失败任务终态写入结果未知，保守保留预留'
        );
      });
      throw error;
    }

    await completeActiveJob(
      jobId,
      {
        reservedTokens,
        actualTokens,
        providerCallsStarted,
        providerMeasuredCalls,
        conservativeFallbackCalls,
        keywordCount: keywords.length,
      },
      actualTokens
    );
    return NextResponse.json({ keywords });
  } catch (error) {
    if (error instanceof DocumentParserError) {
      if (error.code === 'cancelled') {
        return NextResponse.json({ error: 'Request cancelled' }, { status: 499 });
      }
      if (error.code === 'archive_limit' || error.code === 'input_limit') {
        return NextResponse.json(
          { error: 'Document is too large or complex', code: 'document_too_complex' },
          { status: 413 }
        );
      }
      if (
        error.code === 'invalid_archive' ||
        error.code === 'invalid_document' ||
        error.code === 'unsupported_type'
      ) {
        return NextResponse.json(
          { error: 'Invalid document', code: 'invalid_document' },
          { status: 400 }
        );
      }
      if (error.code === 'timeout') {
        return NextResponse.json(
          { error: 'Document parsing timed out', code: 'document_parse_timeout' },
          { status: 422 }
        );
      }
      return NextResponse.json(
        { error: 'Document parser unavailable', code: 'parser_unavailable' },
        {
          status: 503,
          headers: error.code === 'busy' ? { 'Retry-After': '5' } : undefined,
        }
      );
    }
    if (error instanceof ActiveJobBudgetExceededError) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(
          ((error.resetAt?.getTime() ?? Date.now() + 60_000) - Date.now()) /
            1000
        )
      );
      return NextResponse.json(
        {
          error: 'Keyword extraction token budget exhausted',
          dimension: error.dimension,
        },
        {
          status: 429,
          headers: { 'Retry-After': String(retryAfterSeconds) },
        }
      );
    }
    if (error instanceof KeywordRequestError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

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
