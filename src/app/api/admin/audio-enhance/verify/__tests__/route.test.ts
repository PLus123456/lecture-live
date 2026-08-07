import { beforeEach, describe, expect, it, vi } from 'vitest';

// P2-2：本接口一次请求就能完成凭据外带 —— 传一个陌生 workerUrl、token 留空/填掩码，
// 服务端就把解密后的真实 token 以 Authorization: Bearer 送到那台主机。
// parseWorkerUrls 保持真实（被测的正是「地址是否在已保存集合里」的判定）。
const { requireAdminAccessMock, getSiteSettingsMock, pingEnhanceWorkerMock } =
  vi.hoisted(() => ({
    requireAdminAccessMock: vi.fn(),
    getSiteSettingsMock: vi.fn(),
    pingEnhanceWorkerMock: vi.fn(),
  }));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/siteSettings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/siteSettings')>(
    '@/lib/siteSettings'
  );
  return { ...actual, getSiteSettings: getSiteSettingsMock };
});

vi.mock('@/lib/storage/cloudreve', () => ({
  validateCloudreveBaseUrl: vi.fn(),
}));

vi.mock('@/lib/audio/enhanceWorkerClient', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/audio/enhanceWorkerClient')
  >('@/lib/audio/enhanceWorkerClient');
  return { ...actual, pingEnhanceWorker: pingEnhanceWorkerMock };
});

import { POST } from '@/app/api/admin/audio-enhance/verify/route';
import { SETTING_SECRET_MASK } from '@/lib/siteSettings';

const SAVED = {
  audio_enhance_worker_url: 'https://w1.corp.example,https://w2.corp.example',
  audio_enhance_worker_token: 'real-worker-token',
};

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/audio-enhance/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/admin/audio-enhance/verify — 改端点必须重填 token', () => {
  beforeEach(() => {
    requireAdminAccessMock.mockReset();
    getSiteSettingsMock.mockReset();
    pingEnhanceWorkerMock.mockReset();

    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
      response: null,
    });
    getSiteSettingsMock.mockResolvedValue({ ...SAVED });
    pingEnhanceWorkerMock.mockResolvedValue({
      version: '1',
      engines: ['deep-filter'],
      queue: { running: 0 },
    });
  });

  it('陌生地址 + token 填掩码 → 400，且一个探测请求都不发（核心攻击形状）', async () => {
    const res = await POST(
      makeRequest({
        workerUrl: 'https://attacker.tld',
        workerToken: SETTING_SECRET_MASK,
      })
    );
    expect(res.status).toBe(400);
    expect(pingEnhanceWorkerMock).not.toHaveBeenCalled();
  });

  it('陌生地址 + token 整个不传 → 同样 400', async () => {
    const res = await POST(makeRequest({ workerUrl: 'https://attacker.tld' }));
    expect(res.status).toBe(400);
    expect(pingEnhanceWorkerMock).not.toHaveBeenCalled();
  });

  it('已保存地址里混一个陌生地址 → 整笔拒绝，不逐台放行', async () => {
    const res = await POST(
      makeRequest({
        workerUrl: 'https://w1.corp.example,https://attacker.tld',
        workerToken: '',
      })
    );
    expect(res.status).toBe(400);
    expect(pingEnhanceWorkerMock).not.toHaveBeenCalled();
  });

  it('陌生地址但本次显式给了 token → 放行，且用的是新 token', async () => {
    const res = await POST(
      makeRequest({
        workerUrl: 'https://new-vendor.example',
        workerToken: 'freshly-typed-token',
      })
    );
    expect(res.status).toBe(200);
    expect(pingEnhanceWorkerMock).toHaveBeenCalledWith({
      baseUrl: 'https://new-vendor.example',
      token: 'freshly-typed-token',
    });
  });

  it('已保存地址（顺序/尾斜杠不同）+ 掩码 token → 照常探测，沿用已存 token', async () => {
    const res = await POST(
      makeRequest({
        workerUrl: 'https://w2.corp.example/, https://w1.corp.example',
        workerToken: SETTING_SECRET_MASK,
      })
    );
    expect(res.status).toBe(200);
    expect(pingEnhanceWorkerMock).toHaveBeenCalledWith({
      baseUrl: 'https://w2.corp.example',
      token: 'real-worker-token',
    });
  });

  it('没传 workerUrl → 回落已保存地址，照常探测', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(200);
    expect(pingEnhanceWorkerMock).toHaveBeenCalledTimes(2);
  });
});
