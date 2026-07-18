import { beforeEach, describe, expect, it, vi } from 'vitest';

// #10：注册域名白名单/一次性邮箱黑名单的 PUT 侧校验。
// 只 mock 数据访问与鉴权；@/lib/email/domains 保持真实——被测的正是它的解析口径。
const {
  requireAdminAccessMock,
  siteSettingUpsertMock,
  transactionMock,
  userUpdateManyMock,
  getSiteSettingsMock,
} = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  siteSettingUpsertMock: vi.fn(),
  transactionMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  getSiteSettingsMock: vi.fn(),
}));

vi.mock('@/lib/adminApi', () => ({
  requireAdminAccess: requireAdminAccessMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteSetting: { upsert: siteSettingUpsertMock },
    user: { updateMany: userUpdateManyMock },
    $transaction: transactionMock,
  },
}));

vi.mock('@/lib/siteSettings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/siteSettings')>(
    '@/lib/siteSettings'
  );
  return {
    ...actual,
    getSiteSettings: getSiteSettingsMock,
    invalidateSiteSettingsCache: vi.fn(),
  };
});

vi.mock('@/lib/crypto', () => ({ encrypt: (v: string) => `enc:${v}` }));
vi.mock('@/lib/auditLog', () => ({ logAction: vi.fn() }));
vi.mock('@/lib/soniox/env', () => ({ invalidateSonioxDbConfigCache: vi.fn() }));
vi.mock('@/lib/clientIp', () => ({ invalidateTrustedProxyCache: vi.fn() }));
vi.mock('@/lib/email/mailer', () => ({ invalidateMailer: vi.fn() }));
vi.mock('@/lib/storage/migration', () => ({ migrateLocalToCloudreve: vi.fn() }));
vi.mock('@/lib/storage/cloudreve', () => ({
  clearPersistedTokens: vi.fn(),
  invalidateCloudreveConfigCache: vi.fn(),
  validateCloudreveBaseUrl: vi.fn(),
}));
vi.mock('@/lib/audio/enhanceWorkerClient', () => ({
  parseWorkerUrls: () => [],
}));

import { PUT } from '@/app/api/admin/settings/route';

// 只需覆盖 PUT 后续会读的字段（配额联动 / Cloudreve 凭据变更 / 存储模式切换）；
// 前后一致即可让这些分支保持静默，测试聚焦域名列表校验本身。
const SETTINGS_FIXTURE = {
  chat_files_quota_free_mb: 100,
  chat_files_quota_pro_mb: 100,
  chat_files_quota_admin_mb: 100,
  cloudreve_url: '',
  cloudreve_client_id: '',
  cloudreve_client_secret: '',
  storage_mode: 'local',
};

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 取出本次 PUT 实际落库的某个 key 的值（找不到返回 undefined）。 */
function upsertedValue(key: string): string | undefined {
  const call = siteSettingUpsertMock.mock.calls.find(
    ([arg]) => arg?.where?.key === key
  );
  return call?.[0]?.create?.value;
}

describe('PUT /api/admin/settings — 域名列表校验（#10）', () => {
  beforeEach(() => {
    requireAdminAccessMock.mockReset();
    siteSettingUpsertMock.mockReset();
    transactionMock.mockReset();
    userUpdateManyMock.mockReset();
    getSiteSettingsMock.mockReset();

    requireAdminAccessMock.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@test.com', role: 'ADMIN' },
      response: null,
    });
    siteSettingUpsertMock.mockImplementation((args) => args);
    transactionMock.mockResolvedValue([]);
    userUpdateManyMock.mockResolvedValue({ count: 0 });
    getSiteSettingsMock.mockResolvedValue({ ...SETTINGS_FIXTURE });
  });

  it('白名单含无法识别的条目 → 400，并回显是哪一条', async () => {
    const res = await PUT(makeRequest({ email_domain_allowlist: 'edu.cn, *.edu.cn' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('*.edu.cn');
    // 关键：整笔拒绝，不允许「存一半」——否则又回到管理员以为生效的老状态
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('整串都不合法（老 bug 的原始场景）→ 400 而不是存成空列表', async () => {
    const res = await PUT(
      makeRequest({
        email_domain_allowlist: '*.edu.cn',
        email_domain_allowlist_enforce: true,
      })
    );
    expect(res.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('一次性邮箱补充黑名单同样校验', async () => {
    const res = await PUT(makeRequest({ disposable_email_extra: '.temp-corp.io' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('.temp-corp.io');
  });

  it('合法输入落库为归一化结果（设置页看到的=实际生效的）', async () => {
    const res = await PUT(
      makeRequest({ email_domain_allowlist: '  EDU.CN , @stanford.edu\n pku.edu.cn ' })
    );
    expect(res.status).toBe(200);
    expect(upsertedValue('email_domain_allowlist')).toBe(
      'edu.cn,stanford.edu,pku.edu.cn'
    );
  });

  it('清空白名单（空串）仍然放行', async () => {
    const res = await PUT(makeRequest({ email_domain_allowlist: '' }));
    expect(res.status).toBe(200);
    expect(upsertedValue('email_domain_allowlist')).toBe('');
  });
});
