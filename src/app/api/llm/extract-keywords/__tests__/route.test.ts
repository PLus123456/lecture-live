/**
 * P4-2：一次请求扇出数千次不计费 LLM 调用。
 *
 * 锁住三件事：
 *  ① `text` 分支有字符上限（旧代码零校验，真上限是 Next 的 32MB 静默截断 → 约 3200 块）；
 *  ② map 阶段块数封顶（每块一次 callLLM，块数=扇出倍数，gateway 不扣配额不动钱包）；
 *  ③ 限流按用户分桶且排在认证之后（旧顺序走 IP 桶，TRUSTED_PROXY 缺省时全站共用一个桶）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthMock,
  enforceRateLimitMock,
  callLLMMock,
  getProviderForPurposeMock,
  extractTextFromFileMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
  callLLMMock: vi.fn(),
  getProviderForPurposeMock: vi.fn(),
  extractTextFromFileMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/llm/gateway', () => ({
  callLLM: callLLMMock,
  getProviderForPurpose: getProviderForPurposeMock,
}));
vi.mock('@/lib/fileParser', () => ({ extractTextFromFile: extractTextFromFileMock }));

import { POST } from '../route';

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

describe('POST /api/llm/extract-keywords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    enforceRateLimitMock.mockResolvedValue(null);
    // 小上下文窗 → 必定走 map-reduce 分支
    getProviderForPurposeMock.mockResolvedValue({ contextWindow: 8000 });
    callLLMMock.mockResolvedValue(JSON.stringify(['alpha', 'beta']));
  });

  it('P4-2：text 分支超长直接 413，且一次 LLM 都不调', async () => {
    const res = await POST(mkRequest({ text: mkLongText(400_001) }));
    expect(res.status).toBe(413);
    expect(callLLMMock).not.toHaveBeenCalled();
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
});
