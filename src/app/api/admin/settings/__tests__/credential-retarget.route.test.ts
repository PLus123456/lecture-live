import { beforeEach, describe, expect, it, vi } from 'vitest';

// P2-1 / P2-2：写入侧的「改端点必须重填凭据」闸。
// 攻击形状：一次 PUT {smtp_host: 攻击者, smtp_password: '********'} 就换了发信目标又留住原口令，
// 紧接着 invalidateMailer() 让下一封验证信/重置信对新 host 跑 AUTH LOGIN —— 明文口令随之送出。
// 只 mock 数据访问/鉴权；@/lib/credentialRetarget 保持真实——被测的正是它的判定口径。
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

import { PUT } from '@/app/api/admin/settings/route';
import { SETTING_SECRET_MASK } from '@/lib/siteSettings';

// 已保存配置：SMTP / Cloudreve / 增强 worker 三套凭据都已配好（= 都有东西可外带）。
const SETTINGS_FIXTURE = {
  smtp_host: 'smtp.corp.example',
  smtp_port: 587,
  smtp_user: 'postmaster@corp.example',
  smtp_password: 'real-smtp-password',
  cloudreve_url: 'https://drive.corp.example',
  cloudreve_client_id: 'client-1',
  cloudreve_client_secret: 'real-client-secret',
  audio_enhance_worker_url: 'https://w1.corp.example,https://w2.corp.example',
  audio_enhance_worker_token: 'real-worker-token',
  chat_files_quota_free_mb: 100,
  chat_files_quota_pro_mb: 100,
  chat_files_quota_admin_mb: 100,
  storage_mode: 'local',
};

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/admin/settings — 改端点必须重填凭据', () => {
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

  it('改 smtp_host + 密码填掩码 → 400，且一个字都不落库（P2-1 核心）', async () => {
    const res = await PUT(
      makeRequest({
        smtp_host: 'attacker.tld',
        smtp_password: SETTING_SECRET_MASK,
      })
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('SMTP'),
    });
    // 关键：整笔拒绝——否则 host 已换、口令仍在，下一封信就把明文送出去了
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('改 smtp_host + 密码字段整个不传 → 同样 400', async () => {
    const res = await PUT(makeRequest({ smtp_host: 'attacker.tld' }));
    expect(res.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('只改 smtp_port / smtp_user 也算改靶（口令绑在 host+port+账号上）', async () => {
    const portRes = await PUT(
      makeRequest({ smtp_port: '2525', smtp_password: '' })
    );
    expect(portRes.status).toBe(400);

    const userRes = await PUT(
      makeRequest({ smtp_user: 'mallory@attacker.tld', smtp_password: '' })
    );
    expect(userRes.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('改 host 同时重填了密码 → 放行并落库新密码', async () => {
    const res = await PUT(
      makeRequest({
        smtp_host: 'smtp.newvendor.example',
        smtp_password: 'brand-new-password',
      })
    );
    expect(res.status).toBe(200);
    const pwdCall = siteSettingUpsertMock.mock.calls.find(
      ([arg]) => arg?.where?.key === 'smtp_password'
    );
    expect(pwdCall?.[0]?.create?.value).toBe('enc:brand-new-password');
  });

  it('端点原样回填（含数字端口/首尾空白）+ 掩码密码 → 放行，保持原密码', async () => {
    const res = await PUT(
      makeRequest({
        smtp_host: ' smtp.corp.example ',
        smtp_port: '587',
        smtp_user: 'postmaster@corp.example',
        smtp_password: SETTING_SECRET_MASK,
        site_name: 'New Name',
      })
    );
    expect(res.status).toBe(200);
    // 掩码=保持原值的老语义不变：不写 smtp_password
    const pwdCall = siteSettingUpsertMock.mock.calls.find(
      ([arg]) => arg?.where?.key === 'smtp_password'
    );
    expect(pwdCall).toBeUndefined();
  });

  it('库里本来没存密码 → 换 host 不拦（没东西可外带）', async () => {
    getSiteSettingsMock.mockResolvedValue({
      ...SETTINGS_FIXTURE,
      smtp_password: '',
    });
    const res = await PUT(makeRequest({ smtp_host: 'smtp.newvendor.example' }));
    expect(res.status).toBe(200);
  });

  it('改 cloudreve_url + client_secret 填掩码 → 400（同款形状）', async () => {
    const res = await PUT(
      makeRequest({
        cloudreve_url: 'https://attacker.tld',
        cloudreve_client_id: 'client-1',
        cloudreve_client_secret: SETTING_SECRET_MASK,
      })
    );
    expect(res.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('增强 worker 地址加一台新主机 + token 填掩码 → 400', async () => {
    const res = await PUT(
      makeRequest({
        audio_enhance_worker_url:
          'https://w1.corp.example,https://w2.corp.example,https://attacker.tld',
        audio_enhance_worker_token: SETTING_SECRET_MASK,
      })
    );
    expect(res.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('worker 地址仅分隔符/空白差异 → 视为没变，放行', async () => {
    const res = await PUT(
      makeRequest({
        audio_enhance_worker_url:
          'https://w1.corp.example,  https://w2.corp.example/',
        audio_enhance_worker_token: SETTING_SECRET_MASK,
      })
    );
    expect(res.status).toBe(200);
  });
});
