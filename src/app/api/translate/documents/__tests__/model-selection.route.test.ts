import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 文档翻译的模型选择：
 *  ① 用户在文档 tab 选的模型要定格进 task.modelId（派发与 LLM 代理全程认这个快照）；
 *  ② 门禁与句子翻译同口径 —— 必须挂 TRANSLATION 用途 + 过 allowedModels，组绑定模型豁免；
 *  ③ 没选时的组绑定必须按 **DB 行** 解析：verifyAuth 的载荷没有 customGroupId，
 *     传它会把自定义组绑的模型误判成底层系统角色绑的那个，且错快照会一路赢到派发端。
 */

const {
  verifyAuthMock,
  enforceApiRateLimitMock,
  getSiteSettingsMock,
  resolveUserFeatureFlagsMock,
  resolveUserTranslationModelIdMock,
  getModelByIdMock,
  userFindUniqueMock,
  taskCreateMock,
  taskUpdateMock,
  taskFindUniqueMock,
  taskDeleteManyMock,
  saveSourceFileMock,
  getInfoMock,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceApiRateLimitMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  resolveUserFeatureFlagsMock: vi.fn(),
  resolveUserTranslationModelIdMock: vi.fn(),
  getModelByIdMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  taskCreateMock: vi.fn(),
  taskUpdateMock: vi.fn(),
  taskFindUniqueMock: vi.fn(),
  taskDeleteManyMock: vi.fn(),
  saveSourceFileMock: vi.fn(),
  getInfoMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/rateLimit', () => ({ enforceApiRateLimit: enforceApiRateLimitMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/userRoles', () => ({
  resolveUserFeatureFlags: resolveUserFeatureFlagsMock,
  resolveUserTranslationModelId: resolveUserTranslationModelIdMock,
}));
vi.mock('@/lib/llm/gateway', () => ({ getModelById: getModelByIdMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: userFindUniqueMock },
    translationTask: {
      create: taskCreateMock,
      update: taskUpdateMock,
      findUnique: taskFindUniqueMock,
      deleteMany: taskDeleteManyMock,
    },
  },
}));
vi.mock('@/lib/translate/taskStorage', () => ({
  saveSourceFile: saveSourceFileMock,
  deleteTaskFiles: vi.fn(),
}));
// PDF 解析已搬进受限子进程；路由不再直接 import('pdf-parse')。
vi.mock('@/lib/documentParserProcess', () => ({
  DocumentParserError: class DocumentParserError extends Error {
    constructor(
      message: string,
      readonly code: string
    ) {
      super(message);
      this.name = 'DocumentParserError';
    }
  },
  inspectPdfDocument: getInfoMock,
}));
// 合并后路由在 try 之前先过权益准入闸，未 mock 会直接打到真实 $queryRaw。
vi.mock('@/lib/payment/entitlementAdmission', () => ({
  isPaymentBenefitAvailable: vi.fn().mockResolvedValue(true),
}));

import { POST } from '@/app/api/translate/documents/route';

const TRANSLATION_MODELS: Record<string, { dbModelId: string; purpose: string; model: string; name: string }> = {
  'model-allowed': { dbModelId: 'model-allowed', purpose: 'TRANSLATION', model: 'deepseek-chat', name: 'ds' },
  'model-forbidden': { dbModelId: 'model-forbidden', purpose: 'TRANSLATION', model: 'gpt-4o', name: 'gpt' },
  'model-group': { dbModelId: 'model-group', purpose: 'TRANSLATION', model: 'qwen-max', name: 'qwen' },
  'model-chat': { dbModelId: 'model-chat', purpose: 'CHAT', model: 'chat-only', name: 'chat' },
};

function makeReq(fields: Record<string, string> = {}): Request {
  const form = new FormData();
  form.append(
    'file',
    new File([Buffer.from('%PDF-1.4 fake')], 'paper.pdf', { type: 'application/pdf' })
  );
  form.append('sourceLang', 'en');
  form.append('targetLang', 'zh');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request('http://localhost:3000/api/translate/documents', {
    method: 'POST',
    body: form,
  });
}

/** 建任务时写进 modelId 列的值 */
function snapshotModelId(): string | null | undefined {
  const call = taskCreateMock.mock.calls[0]?.[0] as
    | { data?: { modelId?: string | null } }
    | undefined;
  return call?.data?.modelId;
}

describe('POST /api/translate/documents 模型选择', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', email: 'u@x.com', role: 'FREE' });
    enforceApiRateLimitMock.mockResolvedValue(null);
    getSiteSettingsMock.mockResolvedValue({
      translation_doc_enabled: true,
      translation_doc_max_mb: 30,
      translation_doc_max_pages: 300,
      translation_doc_price_cents_per_page: 10,
      default_source_lang: 'en',
      default_target_lang: 'zh',
    });
    resolveUserFeatureFlagsMock.mockResolvedValue({ allowDocTranslation: true });
    resolveUserTranslationModelIdMock.mockResolvedValue(null);
    getModelByIdMock.mockImplementation(async (id: string) => TRANSLATION_MODELS[id] ?? null);
    userFindUniqueMock.mockImplementation(async (args: { select?: Record<string, unknown> }) =>
      args.select?.walletBalanceCents
        ? { walletBalanceCents: 5000 }
        : { role: 'FREE', customGroupId: 'grp-1', allowedModels: 'model-allowed' }
    );
    taskCreateMock.mockResolvedValue({ id: 'task-1' });
    taskUpdateMock.mockResolvedValue({});
    taskFindUniqueMock.mockResolvedValue(null);
    taskDeleteManyMock.mockResolvedValue({ count: 1 });
    saveSourceFileMock.mockResolvedValue('/tmp/task-1/source.pdf');
    getInfoMock.mockResolvedValue({ pages: 12 });
  });

  it('用户选的模型（在 allowedModels 内）定格进任务快照', async () => {
    const res = await POST(makeReq({ modelId: 'model-allowed' }));

    expect(res.status).toBe(200);
    expect(snapshotModelId()).toBe('model-allowed');
  });

  it('选了未授权的模型 → 403，任务不建、PDF 也不解析', async () => {
    const res = await POST(makeReq({ modelId: 'model-forbidden' }));

    expect(res.status).toBe(403);
    expect(taskCreateMock).not.toHaveBeenCalled();
    expect(getInfoMock).not.toHaveBeenCalled();
  });

  it('选了非 TRANSLATION 用途的模型 → 403', async () => {
    const res = await POST(makeReq({ modelId: 'model-chat' }));

    expect(res.status).toBe(403);
    expect(taskCreateMock).not.toHaveBeenCalled();
  });

  it('组绑定模型不在 allowedModels 里也放行（与 /api/translate/models 下发的默认项同口径）', async () => {
    resolveUserTranslationModelIdMock.mockResolvedValue('model-group');

    const res = await POST(makeReq({ modelId: 'model-group' }));

    expect(res.status).toBe(200);
    expect(snapshotModelId()).toBe('model-group');
  });

  it('没选模型 → 用组绑定，且组绑定按 DB 行解析（载荷没有 customGroupId）', async () => {
    resolveUserTranslationModelIdMock.mockResolvedValue('model-group');

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(snapshotModelId()).toBe('model-group');
    // 回归闸：传进去的必须是带 customGroupId 的 DB 行，不是 verifyAuth 的 {id,email,role}
    expect(resolveUserTranslationModelIdMock).toHaveBeenCalledWith(
      expect.objectContaining({ customGroupId: 'grp-1' })
    );
  });

  it('既没选也没组绑定 → 快照留空，交给派发时的全局 TRANSLATION 默认', async () => {
    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(snapshotModelId()).toBeNull();
  });
});
