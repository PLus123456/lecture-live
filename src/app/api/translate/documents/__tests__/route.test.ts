import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthMock,
  enforceApiRateLimitMock,
  getSiteSettingsMock,
  resolveUserFeatureFlagsMock,
  inspectPdfDocumentMock,
  translationTaskCreateMock,
  saveSourceFileMock,
  MockDocumentParserError,
} = vi.hoisted(() => ({
  verifyAuthMock: vi.fn(),
  enforceApiRateLimitMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
  resolveUserFeatureFlagsMock: vi.fn(),
  inspectPdfDocumentMock: vi.fn(),
  translationTaskCreateMock: vi.fn(),
  saveSourceFileMock: vi.fn(),
  MockDocumentParserError: class DocumentParserError extends Error {
    constructor(
      message: string,
      readonly code: string
    ) {
      super(message);
      this.name = 'DocumentParserError';
    }
  },
}));

vi.mock('@/lib/auth', () => ({ verifyAuth: verifyAuthMock }));
vi.mock('@/lib/payment/entitlementAdmission', () => ({
  isPaymentBenefitAvailable: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/rateLimit', () => ({ enforceApiRateLimit: enforceApiRateLimitMock }));
vi.mock('@/lib/siteSettings', () => ({ getSiteSettings: getSiteSettingsMock }));
vi.mock('@/lib/userRoles', () => ({
  resolveUserFeatureFlags: resolveUserFeatureFlagsMock,
  resolveUserTranslationModelId: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/llm/gateway', () => ({ getModelById: vi.fn() }));
vi.mock('@/lib/documentParserProcess', () => ({
  DocumentParserError: MockDocumentParserError,
  inspectPdfDocument: inspectPdfDocumentMock,
}));
vi.mock('@/lib/translate/taskStorage', () => ({
  saveSourceFile: saveSourceFileMock,
  deleteTaskFiles: vi.fn(),
}));
vi.mock('@/lib/translate/taskApi', () => ({
  TASK_VIEW_SELECT: {},
  toTaskView: (value: unknown) => value,
  quoteCents: vi.fn(() => 1),
  sanitizeGlossary: (value: unknown) => value,
  sanitizeLangCode: (value: unknown, fallback: string) =>
    typeof value === 'string' ? value : fallback,
  sweepExpiredQuotes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    translationTask: {
      findMany: vi.fn(),
      create: translationTaskCreateMock,
      update: vi.fn(),
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
    },
    user: { findUnique: vi.fn() },
  },
}));

import { POST } from '../route';

function makePdfRequest(): Request {
  const form = new FormData();
  form.append(
    'file',
    new Blob(['%PDF-1.4\n%%EOF\n'], { type: 'application/pdf' }),
    'document.pdf'
  );
  return new Request('http://localhost/api/translate/documents', {
    method: 'POST',
    body: form,
  });
}

describe('POST /api/translate/documents parser boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAuthMock.mockResolvedValue({ id: 'user-1', role: 'PRO' });
    enforceApiRateLimitMock.mockResolvedValue(null);
    getSiteSettingsMock.mockResolvedValue({
      translation_doc_enabled: true,
      translation_doc_max_mb: 30,
      translation_doc_max_pages: 500,
      translation_doc_price_cents_per_page: 1,
      default_source_lang: 'en',
      default_target_lang: 'zh',
    });
    resolveUserFeatureFlagsMock.mockResolvedValue({ allowDocTranslation: true });
  });

  it.each([
    { code: 'cancelled', status: 499 },
    { code: 'input_limit', status: 413 },
    { code: 'timeout', status: 422 },
    { code: 'busy', status: 503 },
    { code: 'worker_failed', status: 503 },
    { code: 'invalid_document', status: 400 },
  ])('maps child error $code to $status before DB/file writes', async ({ code, status }) => {
    const request = makePdfRequest();
    inspectPdfDocumentMock.mockRejectedValueOnce(
      new MockDocumentParserError('private parser detail', code)
    );

    const response = await POST(request);

    expect(response.status).toBe(status);
    expect(inspectPdfDocumentMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      { signal: request.signal }
    );
    expect(translationTaskCreateMock).not.toHaveBeenCalled();
    expect(saveSourceFileMock).not.toHaveBeenCalled();
    await expect(response.text()).resolves.not.toContain('private parser detail');
  });
});
