import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest } from '../../../../../../tests/utils/http';

/**
 * L21：句子翻译必须「先鉴权、后扣费」。
 * 原顺序反过来，per_char 模式下组绑定模型不在 allowedModels 时必现扣了钱又 403，
 * 而 /api/translate/models 恰恰把组绑定模型当默认项下发 —— 前端按默认值提交就中招，
 * 再叠加自动翻译 800ms 防抖，每敲一次键盘扣一次。
 */

const {
  verifyAuthMock,
  enforceApiRateLimitMock,
  getSiteSettingsMock,
  resolveAuthorizedLlmSelectionMock,
  resolveUserTranslationModelIdMock,
  resolveGroupBoundModelMock,
  getModelByIdMock,
  spendWalletCentsMock,
  consumeDailyTextQuotaMock,
  releaseDailyTextQuotaMock,
  callLLMWithHistoryStreamMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceApiRateLimitMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  resolveAuthorizedLlmSelectionMock: vi.fn(),
  resolveUserTranslationModelIdMock: vi.fn(),
  resolveGroupBoundModelMock: vi.fn(),
  getModelByIdMock: vi.fn(),
  spendWalletCentsMock: vi.fn(),
  consumeDailyTextQuotaMock: vi.fn(),
  releaseDailyTextQuotaMock: vi.fn(),
  callLLMWithHistoryStreamMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceApiRateLimit: enforceApiRateLimitMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/llm/access', () => ({
  LLMAccessError: class LLMAccessError extends Error {},
  resolveAuthorizedLlmSelection: resolveAuthorizedLlmSelectionMock,
}));
vi.mock('@/lib/userRoles', () => ({
  resolveUserTranslationModelId: resolveUserTranslationModelIdMock,
}));
vi.mock('@/lib/llm/summaryModel', () => ({
  resolveGroupBoundModel: resolveGroupBoundModelMock,
}));
vi.mock('@/lib/llm/gateway', () => ({
  getModelById: getModelByIdMock,
  callLLMWithHistoryStream: callLLMWithHistoryStreamMock,
}));
vi.mock('@/lib/wallet', () => ({
  spendWalletCents: spendWalletCentsMock,
  WalletError: class WalletError extends Error {
    constructor(
      message: string,
      readonly code?: string
    ) {
      super(message);
    }
  },
}));
vi.mock('@/lib/translate/textTranslation', () => ({
  buildTextTranslationPrompt: () => ({ system: 'S', user: 'U' }),
  consumeDailyTextQuota: consumeDailyTextQuotaMock,
  releaseDailyTextQuota: releaseDailyTextQuotaMock,
}));

import { POST } from '@/app/api/translate/text/route';

function makeReq(body: Record<string, unknown>) {
  return createJsonRequest('http://localhost:3000/api/translate/text', {
    method: 'POST',
    body,
  });
}

describe('POST /api/translate/text 计费顺序 (L21)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    enforceApiRateLimitMock.mockResolvedValue(null);
    getSiteSettingsMock.mockResolvedValue({
      translation_text_enabled: true,
      translation_text_billing_mode: 'per_char',
      translation_text_price_cents_per_kchar: 5,
      translation_text_daily_free_limit: 10,
    });
    resolveAuthorizedLlmSelectionMock.mockResolvedValue({
      user: { role: 'PRO', allowedModels: 'model-allowed' },
      featureFlags: { allowTextTranslation: true },
    });
    resolveUserTranslationModelIdMock.mockResolvedValue(null);
    resolveGroupBoundModelMock.mockResolvedValue({
      routing: { purpose: 'TRANSLATION' },
      provider: null,
    });
    spendWalletCentsMock.mockResolvedValue({});
    consumeDailyTextQuotaMock.mockResolvedValue({ allowed: true, limit: 10 });
    releaseDailyTextQuotaMock.mockResolvedValue(undefined);
    callLLMWithHistoryStreamMock.mockResolvedValue({ text: '译文' });
  });

  it('模型未授权 → 403，且一分钱都不扣', async () => {
    getModelByIdMock.mockResolvedValue({
      dbModelId: 'model-forbidden',
      purpose: 'TRANSLATION',
      model: 'x',
      name: 'x',
    });

    const res = await POST(makeReq({ text: 'hello', targetLang: 'zh', modelId: 'model-forbidden' }));

    expect(res.status).toBe(403);
    expect(spendWalletCentsMock).not.toHaveBeenCalled();
  });

  it('组绑定模型不在 allowedModels 里也放行（与 /api/translate/models 下发的默认项同口径）', async () => {
    resolveUserTranslationModelIdMock.mockResolvedValue('model-group');
    getModelByIdMock.mockResolvedValue({
      dbModelId: 'model-group',
      purpose: 'TRANSLATION',
      model: 'g',
      name: 'g',
    });

    const res = await POST(makeReq({ text: 'hello', targetLang: 'zh', modelId: 'model-group' }));

    expect(res.status).toBe(200);
    expect(spendWalletCentsMock).toHaveBeenCalledTimes(1);
  });

  it('free 模式下模型未授权 → 不消耗每日免费额度', async () => {
    getSiteSettingsMock.mockResolvedValue({
      translation_text_enabled: true,
      translation_text_billing_mode: 'free',
      translation_text_price_cents_per_kchar: 0,
      translation_text_daily_free_limit: 10,
    });
    getModelByIdMock.mockResolvedValue({
      dbModelId: 'model-forbidden',
      purpose: 'TRANSLATION',
      model: 'x',
      name: 'x',
    });

    const res = await POST(makeReq({ text: 'hello', targetLang: 'zh', modelId: 'model-forbidden' }));

    expect(res.status).toBe(403);
    expect(consumeDailyTextQuotaMock).not.toHaveBeenCalled();
    expect(releaseDailyTextQuotaMock).not.toHaveBeenCalled();
  });

  it('鉴权通过 → 正常扣费并返回 SSE 流', async () => {
    getModelByIdMock.mockResolvedValue({
      dbModelId: 'model-allowed',
      purpose: 'TRANSLATION',
      model: 'a',
      name: 'a',
    });

    const res = await POST(makeReq({ text: 'hello', targetLang: 'zh', modelId: 'model-allowed' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(spendWalletCentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', amountCents: 5, type: 'translation' })
    );
  });
});
