import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../tests/utils/http';

/**
 * L41：实时摘要此前只有「字符数」上限（newTranscript / runningContext 各 50K），
 * 完全不看目标模型的 contextWindow。8K 窗口的模型遇上 50K 字符必然 400，而客户端
 * 失败后会把原文原样 unshift 回 buffer 重发 → 每个触发周期循环失败一次，直到用户
 * 手动新建会话。这里锁住「按模型窗口预算截断」。
 */
const {
  verifyAuthMock,
  enforceApiRateLimitMock,
  resolveAuthorizedLlmSelectionMock,
  resolveUserSummaryModelsMock,
  resolveSummaryModelMock,
  callLLMMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceApiRateLimitMock: vi.fn(),
  resolveAuthorizedLlmSelectionMock: vi.fn(),
  resolveUserSummaryModelsMock: vi.fn(),
  resolveSummaryModelMock: vi.fn(),
  callLLMMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
// 路由新增了「账户有无支付争议冻结」的准入检查（走 $queryRaw）；不桩就会打真库。
vi.mock('@/lib/payment/entitlementAdmission', () => ({
  isPaymentBenefitAvailable: vi.fn(async () => true),
}));
vi.mock('@/lib/rateLimit', () => ({
  enforceApiRateLimit: enforceApiRateLimitMock,
}));
vi.mock('@/lib/llm/gateway', () => ({ callLLM: callLLMMock }));
vi.mock('@/lib/llm/access', () => ({
  LLMAccessError: class LLMAccessError extends Error {},
  resolveAuthorizedLlmSelection: resolveAuthorizedLlmSelectionMock,
}));
vi.mock('@/lib/userRoles', () => ({
  resolveUserSummaryModels: resolveUserSummaryModelsMock,
}));
vi.mock('@/lib/llm/summaryModel', () => ({
  resolveSummaryModel: resolveSummaryModelMock,
}));

import { POST } from '@/app/api/llm/summarize/route';

const VALID_SUMMARY_JSON = JSON.stringify({
  new_key_points: ['k'],
  new_definitions: {},
  new_summary: 's',
  new_questions: [],
  updated_running_context: 'ctx',
});

function providerWithWindow(contextWindow: number) {
  return {
    name: 'p',
    displayName: 'p',
    apiBase: 'http://x',
    apiKey: 'k',
    model: 'm',
    thinkingDepth: 'medium',
    thinkingMode: 'NONE',
    supportsThinkingDepth: false,
    supportsImage: false,
    maxTokens: 2048,
    contextWindow,
    temperature: 0.3,
    isAnthropic: false,
    purpose: 'REALTIME_SUMMARY',
  };
}

function makeReq(body: Record<string, unknown>) {
  return createJsonRequest('http://localhost:3000/api/llm/summarize', {
    method: 'POST',
    body,
  });
}

describe('POST /api/llm/summarize（L41 按模型窗口裁剪输入）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    enforceApiRateLimitMock.mockResolvedValue(null);
    resolveAuthorizedLlmSelectionMock.mockResolvedValue({
      user: { role: 'PRO' },
      featureFlags: { allowRealtimeSummary: true },
    });
    resolveUserSummaryModelsMock.mockResolvedValue({
      realtimeSummaryModelId: null,
    });
    callLLMMock.mockResolvedValue(VALID_SUMMARY_JSON);
  });

  it('8K 窗口 + 50K 字符输入 → 发出去的 prompt 被压进预算（不再必然 400）', async () => {
    resolveSummaryModelMock.mockResolvedValue({
      routing: { purpose: 'REALTIME_SUMMARY' },
      provider: providerWithWindow(8192),
    });

    const huge = '这是一段很长的课堂转录。'.repeat(4000).slice(0, 50_000);
    const res = await POST(
      makeReq({ newTranscript: huge, runningContext: '', language: 'zh' })
    );
    expect(res.status).toBe(200);

    const [system, userMsg] = callLLMMock.mock.calls[0] as [string, string];
    const sent = system + userMsg;
    // 老实现会把整整 50K 字符原样塞进去
    expect(sent.length).toBeLessThan(huge.length);
    // CJK 约 1-2 token/字：8192 窗口下发出去的字符数必须远低于窗口的字符等价量
    expect(sent.length).toBeLessThan(8192);
  });

  it('长窗口模型不做任何截断（不误伤）', async () => {
    resolveSummaryModelMock.mockResolvedValue({
      routing: { purpose: 'REALTIME_SUMMARY' },
      provider: providerWithWindow(200_000),
    });

    const text = '课堂转录内容。'.repeat(2000);
    const res = await POST(
      makeReq({ newTranscript: text, runningContext: '', language: 'zh' })
    );
    expect(res.status).toBe(200);

    const [system, userMsg] = callLLMMock.mock.calls[0] as [string, string];
    expect(system + userMsg).toContain(text);
  });

  it('provider 解析不出来时保持旧行为（不截断）', async () => {
    resolveSummaryModelMock.mockResolvedValue({
      routing: { purpose: 'REALTIME_SUMMARY' },
      provider: null,
    });

    const text = '课堂转录内容。'.repeat(2000);
    const res = await POST(
      makeReq({ newTranscript: text, runningContext: '', language: 'zh' })
    );
    expect(res.status).toBe(200);
    const [system, userMsg] = callLLMMock.mock.calls[0] as [string, string];
    expect(system + userMsg).toContain(text);
  });
});
