/**
 * P4-2 / SEC-011：一次请求扇出或重复复制无界提示数据。
 *
 * 锁住四类边界：
 *  ① `text` 分支有字符上限（旧代码零校验，真上限是 Next 的 32MB 静默截断 → 约 3200 块）；
 *  ② map 阶段块数封顶（每块一次 callLLM，块数=扇出倍数，gateway 不扣配额不动钱包）；
 *  ③ existingKeywords 有多维硬上限，map 不复制它，各返回分支均本地过滤；
 *  ④ 整批调用在首个 provider 请求前过预算，且限流仍按用户分桶。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthMock,
  enforceRateLimitMock,
  callLLMMock,
  getProviderForPurposeMock,
  extractTextFromFileMock,
  claimActiveJobMock,
  completeActiveJobMock,
  failActiveJobMock,
  MockActiveJobBudgetExceededError,
  MockActiveJobReservationWindowExpiredError,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  callLLMMock: vi.fn(),
  getProviderForPurposeMock: vi.fn(),
  extractTextFromFileMock: vi.fn(),
  claimActiveJobMock: vi.fn(),
  completeActiveJobMock: vi.fn(),
  failActiveJobMock: vi.fn(),
  MockActiveJobBudgetExceededError: class extends Error {
    constructor(
      readonly scope: string,
      readonly dimension: 'user' | 'global',
      readonly requestedUnits: number,
      readonly limit: number,
      readonly resetAt?: Date
    ) {
      super(`${scope} ${dimension} resource budget exceeded`);
      this.name = 'ActiveJobBudgetExceededError';
    }
  },
  MockActiveJobReservationWindowExpiredError: class extends Error {
    constructor(
      readonly scope: string,
      readonly admissionNow: Date,
      readonly windowStart: Date,
      readonly windowEnd: Date
    ) {
      super(`${scope} resource reservation window expired`);
      this.name = 'ActiveJobReservationWindowExpiredError';
    }
  },
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/payment/entitlementAdmission', () => ({
  isPaymentBenefitAvailable: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/llm/gateway', () => ({
  callLLM: callLLMMock,
  getProviderForPurpose: getProviderForPurposeMock,
}));
vi.mock('@/lib/fileParser', () => ({ extractTextFromFile: extractTextFromFileMock }));
vi.mock('@/lib/jobQueue', () => ({
  ActiveJobBudgetExceededError: MockActiveJobBudgetExceededError,
  ActiveJobReservationWindowExpiredError:
    MockActiveJobReservationWindowExpiredError,
  claimActiveJob: claimActiveJobMock,
  completeActiveJob: completeActiveJobMock,
  failActiveJob: failActiveJobMock,
  JOB_TYPE: { KEYWORD_EXTRACTION: 'keyword_extraction' },
}));

import { POST } from '../route';
import { DocumentParserError } from '@/lib/documentParserProcess';

// 造一份「句子极多」的超长文本：旧代码会把它切成上千块，每块一次 LLM 调用。
function mkLongText(chars: number): string {
  const sentence = 'This is a filler sentence about lectures. ';
  return sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars);
}

// 中文：cl100k 下每字约 1-1.5 token，同样字符数的块数远多于英文（最贴近真实转录稿的形态）。
function mkLongCjkText(chars: number): string {
  const sentence = '这节课我们讨论的是分布式系统里的一致性与可用性权衡。';
  return sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars);
}

function mkRequest(fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return new Request('http://localhost/api/llm/extract-keywords', {
    method: 'POST',
    body: form,
  });
}

function mkFormRequest(form: FormData) {
  return new Request('http://localhost/api/llm/extract-keywords', {
    method: 'POST',
    body: form,
  });
}

describe('POST /api/llm/extract-keywords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    enforceRateLimitMock.mockResolvedValue(null);
    // 小上下文窗 → 必定走 map-reduce 分支
    getProviderForPurposeMock.mockResolvedValue({
      contextWindow: 8000,
      maxTokens: 4096,
    });
    claimActiveJobMock.mockResolvedValue('keyword-job-1');
    completeActiveJobMock.mockResolvedValue(undefined);
    failActiveJobMock.mockResolvedValue(undefined);
    callLLMMock.mockResolvedValue(JSON.stringify(['alpha', 'beta']));
  });

  it('P4-2：text 分支超长直接 413，且一次 LLM 都不调', async () => {
    const res = await POST(mkRequest({ text: mkLongText(400_001) }));
    expect(res.status).toBe(413);
    expect(callLLMMock).not.toHaveBeenCalled();
  });

  it.each([
    { code: 'archive_limit' as const, status: 413 },
    { code: 'invalid_archive' as const, status: 400 },
    { code: 'timeout' as const, status: 422 },
    { code: 'busy' as const, status: 503 },
  ])('SEC-017：解析错误 $code 在任何 LLM/任务调用前映射为 $status', async ({
    code,
    status,
  }) => {
    const form = new FormData();
    form.append('file', new Blob(['not-a-document'], { type: 'application/pdf' }), 'x.pdf');
    extractTextFromFileMock.mockRejectedValueOnce(
      new DocumentParserError('parser detail must not escape', code)
    );

    const res = await POST(mkFormRequest(form));

    expect(res.status).toBe(status);
    expect(callLLMMock).not.toHaveBeenCalled();
    expect(getProviderForPurposeMock).not.toHaveBeenCalled();
    expect(claimActiveJobMock).not.toHaveBeenCalled();
    await expect(res.text()).resolves.not.toContain('parser detail must not escape');
  });

  it('P4-2：合法长文本的 map 扇出被块数上限钉死（不再是数百次调用）', async () => {
    // 40 万中文字符仍在输入闸之内，但按 ~2500 token/块自然会切出 200+ 块。
    const res = await POST(mkRequest({ text: mkLongCjkText(400_000) }));
    expect(res.status).toBe(200);
    // map 每块一次 + 最多一次 merge ⇒ 上限 61 次。旧代码此处随输入长度线性增长。
    expect(callLLMMock.mock.calls.length).toBeLessThanOrEqual(61);
    expect(callLLMMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('P4-2：限流排在认证之后且按用户分桶（不再全站共用一个 IP 桶）', async () => {
    enforceRateLimitMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 })
    );
    const res = await POST(mkRequest({ text: 'hello' }));
    expect(res.status).toBe(429);
    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'user:user-1' })
    );
  });

  it('未认证请求在限流之前就被拒（不消耗任何桶）', async () => {
    verifyAuthMock.mockResolvedValue(null);
    const res = await POST(mkRequest({ text: 'hello' }));
    expect(res.status).toBe(401);
    expect(enforceRateLimitMock).not.toHaveBeenCalled();
  });

  it('SEC-011：existingKeywords 为 File 时严格拒绝，不会强转后进入 prompt', async () => {
    const form = new FormData();
    form.append('text', 'A normal lecture about signal processing.');
    form.append(
      'existingKeywords',
      new Blob(['known keyword'], { type: 'text/plain' }),
      'known.txt'
    );

    const res = await POST(mkFormRequest(form));
    expect(res.status).toBe(400);
    expect(callLLMMock).not.toHaveBeenCalled();
    expect(getProviderForPurposeMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'UTF-8 总字节',
      existingKeywords: 'x'.repeat(16 * 1024 + 1),
    },
    {
      label: '关键词数量',
      existingKeywords: Array.from({ length: 201 }, (_, i) => `term-${i}`).join(','),
    },
    {
      label: '单个关键词长度',
      existingKeywords: 'x'.repeat(121),
    },
    {
      // 200 项、每项 25 个 Unicode 字符、原始 UTF-8 仍小于 16KiB，
      // 但 cl100k 中「龘」占多个 token，可单独命中总 token 上限。
      label: '总 token',
      existingKeywords: Array.from(
        { length: 200 },
        (_, i) => `${i % 10}${'龘'.repeat(24)}`
      ).join(','),
    },
  ])('SEC-011：$label 越界时 413 且零 LLM 调用', async ({ existingKeywords }) => {
    const res = await POST(
      mkRequest({
        text: 'A normal lecture about signal processing.',
        existingKeywords,
      })
    );

    expect(res.status).toBe(413);
    expect(callLLMMock).not.toHaveBeenCalled();
    expect(getProviderForPurposeMock).not.toHaveBeenCalled();
  });

  it('SEC-011：正常已知词仍会进入单次 prompt，并在返回值中本地去除', async () => {
    callLLMMock.mockResolvedValue(
      JSON.stringify(['KNOWN ALPHA', 'Gamma Ray', 'gamma ray'])
    );

    const res = await POST(
      mkRequest({
        text: 'A short lecture about alpha particles and gamma rays.',
        existingKeywords: 'Known Alpha, known alpha, Beta',
      })
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ keywords: ['Gamma Ray'] });
    expect(callLLMMock).toHaveBeenCalledTimes(1);
    expect(callLLMMock.mock.calls[0]?.[0]).toContain('Known Alpha');
    expect(callLLMMock.mock.calls[0]?.[0]).not.toContain('known alpha');
    expect(callLLMMock.mock.calls[0]?.[2]).toMatchObject({
      purpose: 'KEYWORD_EXTRACTION',
      maxOutputTokens: 4096,
    });
    const [systemPrompt, userPrompt] = callLLMMock.mock.calls[0] as [
      string,
      string,
      unknown,
    ];
    const expectedWorstCase =
      new TextEncoder().encode(systemPrompt).byteLength +
      new TextEncoder().encode(userPrompt).byteLength +
      64 +
      4096;
    expect(claimActiveJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'keyword_extraction',
        userId: 'user-1',
        activeKey: expect.stringMatching(/^keyword:user-1:/),
        resourceReservation: expect.objectContaining({
          scope: 'llm_tokens',
          units: expectedWorstCase,
        }),
      })
    );
    expect(claimActiveJobMock.mock.invocationCallOrder[0]).toBeLessThan(
      callLLMMock.mock.invocationCallOrder[0]
    );
    expect(completeActiveJobMock).toHaveBeenCalledWith(
      'keyword-job-1',
      expect.objectContaining({
        reservedTokens: expectedWorstCase,
        actualTokens: expectedWorstCase,
        conservativeFallbackCalls: 1,
      }),
      expectedWorstCase
    );
    expect(failActiveJobMock).not.toHaveBeenCalled();
  });

  it('SEC-011：可信 provider usage 按实际值结算未用预留', async () => {
    callLLMMock.mockImplementation(
      async (
        _system: string,
        _user: string,
        options: { onUsage?: (usage: { totalTokens: number }) => void }
      ) => {
        options.onUsage?.({ totalTokens: 17 });
        return JSON.stringify(['alpha']);
      }
    );

    const res = await POST(mkRequest({ text: 'A short lecture.' }));

    expect(res.status).toBe(200);
    expect(completeActiveJobMock).toHaveBeenCalledWith(
      'keyword-job-1',
      expect.objectContaining({
        actualTokens: 17,
        providerMeasuredCalls: 1,
        conservativeFallbackCalls: 0,
      }),
      17
    );
  });

  it('SEC-011：共享日预算不足时 429 且 claim 前后都没有 provider 调用', async () => {
    claimActiveJobMock.mockRejectedValue(
      new MockActiveJobBudgetExceededError(
        'llm_tokens',
        'user',
        10_000,
        5_000_000,
        new Date(Date.now() + 15_000)
      )
    );

    const res = await POST(mkRequest({ text: 'A short lecture.' }));

    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(callLLMMock).not.toHaveBeenCalled();
    expect(completeActiveJobMock).not.toHaveBeenCalled();
    expect(failActiveJobMock).not.toHaveBeenCalled();
  });

  it('SEC-011：provider 断连按调用上界结算失败任务，不退回可能已消费额度', async () => {
    callLLMMock.mockRejectedValue(new Error('provider disconnected'));

    const res = await POST(mkRequest({ text: 'A short lecture.' }));

    expect(res.status).toBe(500);
    expect(failActiveJobMock).toHaveBeenCalledWith(
      'keyword-job-1',
      expect.any(Error),
      expect.objectContaining({
        providerCallsStarted: 1,
        conservativeFallbackCalls: 1,
      }),
      expect.any(Number)
    );
    const settledUnits = failActiveJobMock.mock.calls[0]?.[3] as number;
    expect(settledUnits).toBeGreaterThan(4096);
    expect(completeActiveJobMock).not.toHaveBeenCalled();
  });

  it('SEC-011：map prompt 不重复已知词，reduce 最多携带一次', async () => {
    let mapIndex = 0;
    callLLMMock.mockImplementation(
      async (_system: string, userMessage: string) => {
        if (userMessage === 'Merge now.') {
          return JSON.stringify(['known-alpha', 'merged-new']);
        }
        const index = mapIndex++;
        return JSON.stringify(
          Array.from({ length: 20 }, (_, i) => `candidate-${index}-${i}`)
        );
      }
    );

    const res = await POST(
      mkRequest({
        text: mkLongText(30_000),
        existingKeywords: 'known-alpha, known-beta',
      })
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ keywords: ['merged-new'] });

    const mapCalls = callLLMMock.mock.calls.filter(
      ([, userMessage]) => userMessage !== 'Merge now.'
    );
    const reduceCalls = callLLMMock.mock.calls.filter(
      ([, userMessage]) => userMessage === 'Merge now.'
    );
    expect(mapCalls.length).toBeGreaterThan(1);
    expect(reduceCalls).toHaveLength(1);
    for (const [systemPrompt] of mapCalls) {
      expect(systemPrompt).not.toContain('known-alpha');
      expect(systemPrompt).not.toContain('known-beta');
    }
    expect(reduceCalls[0]?.[0].match(/known-alpha/g)).toHaveLength(1);
    expect(reduceCalls[0]?.[0].match(/known-beta/g)).toHaveLength(1);
    for (const call of callLLMMock.mock.calls) {
      expect(call[2]).toMatchObject({
        purpose: 'KEYWORD_EXTRACTION',
        maxOutputTokens: 4096,
      });
    }
  });

  it('SEC-011：map 结果无需 reduce 的提前返回也会过滤已知词', async () => {
    let index = 0;
    callLLMMock.mockImplementation(async () =>
      JSON.stringify(['KNOWN ALPHA', `novel-${index++}`])
    );

    const res = await POST(
      mkRequest({
        text: mkLongCjkText(10_000),
        existingKeywords: 'known alpha',
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keywords).not.toContain('KNOWN ALPHA');
    expect(body.keywords.length).toBeGreaterThan(1);
    expect(callLLMMock.mock.calls.length).toBeGreaterThan(1);
    expect(
      callLLMMock.mock.calls.some(([, userMessage]) => userMessage === 'Merge now.')
    ).toBe(false);
  });

  it('SEC-011：整批最坏 token 预算超限时在首个 provider 调用前失败', async () => {
    getProviderForPurposeMock.mockResolvedValue({
      contextWindow: 8000,
      maxTokens: 1_000_000,
    });

    const res = await POST(
      mkRequest({ text: 'A normal lecture about signal processing.' })
    );

    expect(res.status).toBe(413);
    expect(callLLMMock).not.toHaveBeenCalled();
  });

  it.each([
    { contextWindow: 0, maxTokens: 4096 },
    { contextWindow: 8000, maxTokens: 0 },
  ])('SEC-011：非法 provider 预算配置关闭失败且零调用', async (provider) => {
    getProviderForPurposeMock.mockResolvedValue(provider);

    const res = await POST(
      mkRequest({ text: 'A normal lecture about signal processing.' })
    );

    expect(res.status).toBe(503);
    expect(callLLMMock).not.toHaveBeenCalled();
  });
});
