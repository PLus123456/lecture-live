import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #8 核心回归：退订范围只认令牌里签过名的那个。
 * 早先版本把 category 当裸 URL 参数，一封 promotions 退订链接改成 category=all
 * 就能替人关掉全部通知——包括到期提醒、配额提醒这两个跟钱直接相关的。
 */

const { findUniqueMock, updateMock, writeAuditLogMock, resolveRequestClientIpMock } = vi.hoisted(
  () => ({
    findUniqueMock: vi.fn(),
    updateMock: vi.fn(),
    writeAuditLogMock: vi.fn(),
    resolveRequestClientIpMock: vi.fn(),
  })
);

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: findUniqueMock, update: updateMock } },
}));
vi.mock('@/lib/auditLog', () => ({ writeAuditLog: writeAuditLogMock }));
vi.mock('@/lib/clientIp', () => ({ resolveRequestClientIp: resolveRequestClientIpMock }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  serializeError: (e: unknown) => e,
}));

import { GET, POST } from '@/app/api/auth/unsubscribe/route';
import { makeUnsubscribeToken } from '@/lib/email/preferences';

const USER = { id: 'u1', email: 'user@example.com', emailPreferences: null };

/** 从落库的 emailPreferences JSON 里取被关掉的分类。 */
function disabledCategories(): string[] {
  const raw = updateMock.mock.calls[0]?.[0]?.data?.emailPreferences;
  if (!raw) return [];
  return Object.entries(JSON.parse(raw) as Record<string, boolean>)
    .filter(([, v]) => v === false)
    .map(([k]) => k);
}

describe('/api/auth/unsubscribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueMock.mockResolvedValue(USER);
    updateMock.mockResolvedValue(USER);
    resolveRequestClientIpMock.mockReturnValue('1.2.3.4');
  });

  const postForm = (url: string, body?: Record<string, string>) =>
    POST(
      new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body ?? {}).toString(),
      })
    );

  it('凭 promotions 令牌只关掉 promotions', async () => {
    const token = makeUnsubscribeToken('u1', 'promotions');
    const res = await postForm('http://localhost/api/auth/unsubscribe', { token });

    expect(res.status).toBe(200);
    expect(disabledCategories()).toEqual(['promotions']);
  });

  it('URL 上另挂 category=all 不起作用（范围仍取自令牌）', async () => {
    const token = makeUnsubscribeToken('u1', 'promotions');
    const res = await postForm(
      'http://localhost/api/auth/unsubscribe?category=all',
      { token }
    );

    expect(res.status).toBe(200);
    expect(disabledCategories()).toEqual(['promotions']);
  });

  it('表单里另塞 category=all 同样不起作用', async () => {
    const token = makeUnsubscribeToken('u1', 'promotions');
    const res = await postForm('http://localhost/api/auth/unsubscribe', {
      token,
      category: 'all',
    });

    expect(res.status).toBe(200);
    expect(disabledCategories()).toEqual(['promotions']);
  });

  // 审计里那条利用路径的原样复现：拿到一封促销退订信，把令牌里的范围段改成 all。
  it('把令牌里的范围段改成 all → 400 且不写库', async () => {
    const token = makeUnsubscribeToken('u1', 'promotions');
    const [id, , exp, sig] = token.split('.');
    const res = await postForm('http://localhost/api/auth/unsubscribe', {
      token: `${id}.all.${exp}.${sig}`,
    });

    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('凭 all 令牌关掉全部可控分类，但不含事务类安全提醒', async () => {
    const token = makeUnsubscribeToken('u1', 'all');
    const res = await postForm('http://localhost/api/auth/unsubscribe', { token });

    expect(res.status).toBe(200);
    const disabled = disabledCategories();
    expect(disabled).toContain('promotions');
    expect(disabled).toContain('expiry_reminder');
    expect(disabled).toContain('quota_alert');
    expect(disabled).not.toContain('security_alert');
  });

  it('令牌过期 → 400 且不写库', async () => {
    const now = Date.now();
    const token = makeUnsubscribeToken('u1', 'promotions', { now: now - 10_000, ttlMs: 1000 });
    const res = await postForm('http://localhost/api/auth/unsubscribe', { token });

    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('令牌无效 → 400 且不写库', async () => {
    const res = await postForm('http://localhost/api/auth/unsubscribe', { token: 'garbage' });

    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('GET 只展示确认页、不改任何偏好（防邮件扫描器预取误触发）', async () => {
    const token = makeUnsubscribeToken('u1', 'promotions');
    const res = await GET(
      new Request(`http://localhost/api/auth/unsubscribe?token=${encodeURIComponent(token)}`)
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('确认退订');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('GET 确认页展示的是令牌自带范围的名称', async () => {
    const token = makeUnsubscribeToken('u1', 'expiry_reminder');
    const res = await GET(
      new Request(
        `http://localhost/api/auth/unsubscribe?token=${encodeURIComponent(token)}&category=all`
      )
    );

    const html = await res.text();
    expect(html).toContain('会员到期提醒');
    expect(html).not.toContain('全部通知邮件');
  });
});
