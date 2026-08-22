import { beforeEach, describe, expect, it, vi } from 'vitest';

// P2-2：本接口一次请求就能完成凭据外带 —— 传一个陌生 workerUrl、token 留空/填掩码，
// 服务端就把解密后的真实 token 以 Authorization: Bearer 送到那台主机。
// parseWorkerUrls 保持真实（被测的正是「地址是否在已保存集合里」的判定）。
const {
  requireAdminAccessMock,
  getSiteSettingsMock,
  pingEnhanceWorkerMock,
  trackJobMock,
  writeSecurityAuditMock,
} =
  vi.hoisted(() => ({
    requireAdminAccessMock: vi.fn(),
    getSiteSettingsMock: vi.fn(),
    pingEnhanceWorkerMock: vi.fn(),
    trackJobMock: vi.fn(),
    writeSecurityAuditMock: vi.fn(),
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

vi.mock('@/lib/jobQueue', () => ({
  JOB_STATUS: { SUCCESS: 'SUCCESS', FAILED: 'FAILED' },
  JOB_TYPE: { ADMIN_INTEGRATION: 'admin_integration' },
  trackJob: trackJobMock,
}));

vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
}));

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

describe('POST /api/admin/audio-enhance/verify — 换靶闸范围：不设闸（只保 SMTP）', () => {
  beforeEach(() => {
    requireAdminAccessMock.mockReset();
    getSiteSettingsMock.mockReset();
    pingEnhanceWorkerMock.mockReset();
    trackJobMock.mockReset();
    writeSecurityAuditMock.mockReset().mockResolvedValue({});

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
    trackJobMock.mockImplementation(async (options, operation) => {
      const result = await operation();
      await options.terminalMutation(
        { auditLog: { create: vi.fn() } },
        { status: 'SUCCESS', result }
      );
      return result;
    });
  });

  // ↓ 以下三条固化的是「换靶闸只保 SMTP」这个刻意的范围决定（见 admin/settings/route.ts 的说明）。
  //   「填好新地址先点一下测试连接」是常规动作，逼着同时重填 token 会把这个按钮变得很难用。
  //   若有人把这道闸加回来，它们会立刻转红 —— 那时应先回到范围决定本身重新讨论。
  it('未保存的地址 + token 填掩码 → 照常探测（沿用已存 token）', async () => {
    const res = await POST(
      makeRequest({
        workerUrl: 'https://w9.corp.example',
        workerToken: SETTING_SECRET_MASK,
      })
    );
    expect(res.status).toBe(200);
    expect(pingEnhanceWorkerMock).toHaveBeenCalled();
  });

  it('未保存的地址 + token 整个不传 → 同样照常探测', async () => {
    const res = await POST(makeRequest({ workerUrl: 'https://w9.corp.example' }));
    expect(res.status).toBe(200);
    expect(pingEnhanceWorkerMock).toHaveBeenCalled();
  });

  it('已保存地址里混一台新机器 → 整批照常探测', async () => {
    const res = await POST(
      makeRequest({
        workerUrl: 'https://w1.corp.example,https://w9.corp.example',
        workerToken: '',
      })
    );
    expect(res.status).toBe(200);
    expect(pingEnhanceWorkerMock).toHaveBeenCalled();
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

  it('先建 durable journal，且终态审计不记录 URL 或 token', async () => {
    const req = makeRequest({
      workerUrl: 'https://worker.example/private?api_key=leak-me',
      workerToken: 'worker-secret',
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(trackJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'admin_integration',
        params: { operation: 'audio_enhance_verify', workerCount: 1 },
      }),
      expect.any(Function)
    );
    const event = writeSecurityAuditMock.mock.calls[0][1];
    expect(event).toMatchObject({
      event: 'audio_enhance.verify',
      outcome: 'SUCCESS',
      after: { workerCount: 1, reachableCount: 1 },
    });
    expect(JSON.stringify(event)).not.toContain('worker.example');
    expect(JSON.stringify(event)).not.toContain('leak-me');
    expect(JSON.stringify(event)).not.toContain('worker-secret');
  });

  it('终态审计失败时不返回探测成功', async () => {
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(POST(makeRequest({}))).rejects.toThrow('audit unavailable');
    expect(pingEnhanceWorkerMock).toHaveBeenCalled();
  });
});
