import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 仅 mock 数据访问/鉴权/缓存失效；validateCloudreveBaseUrl 保持真实，
// 真正验证 wsUrl/restUrl 的「非法/私网地址被拒」SSRF 防线。
const {
  requireAdminAccessMock,
  siteSettingUpsertMock,
  siteSettingDeleteManyMock,
  siteSettingFindFirstMock,
  siteSettingFindManyMock,
  transactionMock,
  invalidateSiteSettingsCacheMock,
  invalidateSonioxDbConfigCacheMock,
  writeSecurityAuditMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  siteSettingUpsertMock: vi.fn(),
  siteSettingDeleteManyMock: vi.fn(),
  siteSettingFindFirstMock: vi.fn(),
  siteSettingFindManyMock: vi.fn(),
  transactionMock: vi.fn(),
  invalidateSiteSettingsCacheMock: vi.fn(),
  invalidateSonioxDbConfigCacheMock: vi.fn(),
  writeSecurityAuditMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: {
      upsert: siteSettingUpsertMock,
      deleteMany: siteSettingDeleteManyMock,
      findFirst: siteSettingFindFirstMock,
      findMany: siteSettingFindManyMock,
    },
    // U66：写入改走单事务原子提交（数组式 $transaction，元素即 upsert/deleteMany 调用），
    // 这里直接 resolve 即可——数组构造时各 mock 已被调用，故上层断言仍能看到调用参数。
    $transaction: transactionMock,
  },
}));

vi.mock('@/lib/crypto', () => ({
  encrypt: (value: string) => `enc:${value}`,
  decrypt: (value: string) => value.replace(/^enc:/, ''),
}));

vi.mock('@/lib/siteSettings', () => ({
  invalidateSiteSettingsCache: invalidateSiteSettingsCacheMock,
}));

vi.mock('@/lib/soniox/env', () => ({
  invalidateSonioxDbConfigCache: invalidateSonioxDbConfigCacheMock,
}));

vi.mock('@/lib/securityAudit', () => ({
  writeSecurityAudit: writeSecurityAuditMock,
}));

import { PUT } from '@/app/api/admin/soniox/route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/soniox', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/admin/soniox', () => {
  const originalAllowPrivate = process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;

  beforeEach(() => {
    requireAdminAccessMock.mockReset();
    siteSettingUpsertMock.mockReset();
    siteSettingDeleteManyMock.mockReset();
    siteSettingFindFirstMock.mockReset();
    siteSettingFindManyMock.mockReset();
    transactionMock.mockReset();
    invalidateSiteSettingsCacheMock.mockReset();
    invalidateSonioxDbConfigCacheMock.mockReset();
    writeSecurityAuditMock.mockReset().mockResolvedValue({});

    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
      response: null,
    });
    siteSettingUpsertMock.mockResolvedValue({});
    siteSettingDeleteManyMock.mockResolvedValue({ count: 0 });
    siteSettingFindFirstMock.mockResolvedValue(null);
    siteSettingFindManyMock.mockResolvedValue([]);
    transactionMock.mockImplementation(async (callback) =>
      callback({
        siteSetting: {
          upsert: siteSettingUpsertMock,
          deleteMany: siteSettingDeleteManyMock,
          findMany: siteSettingFindManyMock,
        },
        auditLog: { create: vi.fn() },
      })
    );
    delete process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;
  });

  afterEach(() => {
    if (originalAllowPrivate === undefined) {
      delete process.env.CLOUDREVE_ALLOW_PRIVATE_HOST;
    } else {
      process.env.CLOUDREVE_ALLOW_PRIVATE_HOST = originalAllowPrivate;
    }
  });

  it('拒绝非 ws(s) 协议的 wsUrl', async () => {
    const res = await PUT(makeRequest({ regions: { us: { wsUrl: 'https://evil.example.com' } } }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('wsUrl') });
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('拒绝指向内网的 wsUrl（SSRF 防护）', async () => {
    const res = await PUT(
      makeRequest({ regions: { us: { wsUrl: 'wss://127.0.0.1/transcribe-websocket' } } })
    );
    expect(res.status).toBe(400);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('拒绝指向内网的 restUrl（SSRF 防护）', async () => {
    // 用基线 cloudreve 私网黑名单已覆盖的 10/8 地址，使本单元自洽（不依赖 U6 对 169.254 等网段的补全）。
    const res = await PUT(makeRequest({ regions: { us: { restUrl: 'http://10.0.0.1/' } } }));
    expect(res.status).toBe(400);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('拒绝非法 restUrl（不是合法 URL）', async () => {
    const res = await PUT(makeRequest({ regions: { us: { restUrl: 'not-a-url' } } }));
    expect(res.status).toBe(400);
    expect(siteSettingUpsertMock).not.toHaveBeenCalled();
  });

  it('合法 wss/https 地址可写入，并去掉尾部斜杠', async () => {
    const res = await PUT(
      makeRequest({
        regions: {
          us: {
            wsUrl: 'wss://stt-rt.soniox.example/transcribe-websocket/',
            restUrl: 'https://api.soniox.example/',
          },
        },
      })
    );
    expect(res.status).toBe(200);

    const wsCall = siteSettingUpsertMock.mock.calls.find(
      (c) => (c[0] as { where: { key: string } }).where.key === 'soniox_US_ws_url'
    );
    const restCall = siteSettingUpsertMock.mock.calls.find(
      (c) => (c[0] as { where: { key: string } }).where.key === 'soniox_US_rest_url'
    );
    expect((wsCall?.[0] as { create: { value: string } }).create.value).toBe(
      'wss://stt-rt.soniox.example/transcribe-websocket'
    );
    expect((restCall?.[0] as { create: { value: string } }).create.value).toBe(
      'https://api.soniox.example'
    );
  });

  // P2-2：只改 wsUrl/restUrl、apiKey 留空 = 保留已存密钥 → 下一次转录就带着真密钥
  // 连到新地址（Soniox 密钥随握手直接送出）。
  describe('换靶闸范围：Soniox 不设闸（只保 SMTP）', () => {
    beforeEach(() => {
      siteSettingFindManyMock.mockResolvedValue([
        { key: 'soniox_US_api_key', value: 'enc:real-soniox-key' },
        { key: 'soniox_US_ws_url', value: 'wss://stt-rt.soniox.example' },
        { key: 'soniox_US_rest_url', value: 'https://api.soniox.example' },
      ]);
    });

    // ↓ 这条固化的是「换靶闸只保 SMTP」这个刻意的范围决定（见 admin/settings/route.ts 的说明）。
    //   若有人把这道闸加回来，它会立刻转红 —— 那时应先回到范围决定本身重新讨论。
    it('只改 wsUrl、apiKey 不传 → 放行并落库', async () => {
      const res = await PUT(
        makeRequest({ regions: { us: { wsUrl: 'wss://stt-rt2.soniox.example/ws' } } })
      );
      expect(res.status).toBe(200);
      expect(transactionMock).toHaveBeenCalled();
    });

    it('只改 restUrl、apiKey 不传 → 同样放行', async () => {
      const res = await PUT(
        makeRequest({ regions: { us: { restUrl: 'https://api2.soniox.example' } } })
      );
      expect(res.status).toBe(200);
      expect(transactionMock).toHaveBeenCalled();
    });

    it('改地址同时重填 apiKey → 放行', async () => {
      const res = await PUT(
        makeRequest({
          regions: {
            us: { wsUrl: 'wss://stt-rt.newvendor.example', apiKey: 'k2' },
          },
        })
      );
      expect(res.status).toBe(200);
    });

    it('改地址同时显式清空 apiKey（同事务删除，无凭据可外带）→ 放行', async () => {
      const res = await PUT(
        makeRequest({
          regions: { us: { wsUrl: 'wss://stt-rt.newvendor.example', apiKey: '' } },
        })
      );
      expect(res.status).toBe(200);
    });

    it('地址原样回填（仅尾斜杠差异）→ 不算改靶', async () => {
      const res = await PUT(
        makeRequest({
          regions: { us: { wsUrl: 'wss://stt-rt.soniox.example/' } },
        })
      );
      expect(res.status).toBe(200);
    });

    it('该区域没存密钥 → 改地址不拦（没东西可外带）', async () => {
      const res = await PUT(
        makeRequest({ regions: { eu: { wsUrl: 'wss://stt-rt.eu.example' } } })
      );
      expect(res.status).toBe(200);
    });
  });

  it('配置写入与 SUCCESS 审计在同一事务，且审计不含密钥或端点', async () => {
    const res = await PUT(
      makeRequest({
        regions: {
          us: {
            apiKey: 'soniox-secret',
            restUrl: 'https://api.soniox.example/v1?credential=hidden',
          },
        },
      })
    );

    expect(res.status).toBe(200);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(writeSecurityAuditMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        event: 'soniox.update',
        outcome: 'SUCCESS',
        after: expect.objectContaining({ endpointChanged: true }),
      }),
      expect.objectContaining({ siteSetting: expect.any(Object) })
    );
    const auditEvent = writeSecurityAuditMock.mock.calls[0][1];
    expect(JSON.stringify(auditEvent)).not.toContain('soniox-secret');
    expect(JSON.stringify(auditEvent)).not.toContain('api.soniox.example');
    expect(JSON.stringify(auditEvent)).not.toContain('hidden');
  });

  it('审计写失败会回滚配置事务并返回 500', async () => {
    writeSecurityAuditMock.mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await PUT(
      makeRequest({ regions: { us: { restUrl: 'https://api.soniox.example' } } })
    );

    expect(res.status).toBe(500);
    expect(invalidateSiteSettingsCacheMock).not.toHaveBeenCalled();
    expect(invalidateSonioxDbConfigCacheMock).not.toHaveBeenCalled();
  });
});
