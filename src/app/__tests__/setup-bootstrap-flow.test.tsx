import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const state = {
    adminCount: 0,
    adminSession: false,
    setupComplete: false,
  };

  const siteSettingUpsert = vi.fn(async (args: { where: { key: string } }) => {
    if (args.where.key === 'setup_complete') state.setupComplete = true;
    return { key: args.where.key, value: 'true' };
  });
  const redirect = vi.fn();

  const prisma = {
    user: {
      count: vi.fn(async () => state.adminCount),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: { data: { email: string; displayName: string } }) => {
        state.adminCount += 1;
        return {
          id: 'admin-1',
          email: args.data.email,
          displayName: args.data.displayName,
          role: 'ADMIN',
          tokenVersion: 0,
        };
      }),
    },
    siteSetting: {
      findUnique: vi.fn(async (args: { where: { key: string } }) =>
        args.where.key === 'setup_complete' && state.setupComplete
          ? { key: 'setup_complete', value: 'true' }
          : null
      ),
      create: vi.fn(async () => ({ key: 'setup_admin_claimed', value: 'true' })),
      upsert: siteSettingUpsert,
    },
    llmProvider: {
      count: vi.fn(async () => 0),
      create: vi.fn(),
    },
    llmRegistryModel: { create: vi.fn() },
    llmModel: { create: vi.fn() },
    $queryRaw: vi.fn(async () => [{ 1: 1 }]),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));

  return { prisma, redirect, siteSettingUpsert, state };
});

vi.mock('@/lib/prisma', () => ({ prisma: harness.prisma }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: vi.fn(async () => null) }));
vi.mock('@/lib/billing', () => ({ getNextQuotaResetAt: () => new Date(0) }));
vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(async () =>
    harness.state.adminSession
      ? { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' }
      : null
  ),
  verifyAuthToken: vi.fn(async () => null),
  getAuthCookieName: () => 'lecture-live-token',
  getAuthTokenSessionBinding: () => 'binding-setup',
  issueAuthToken: async () => 'signed-token',
  setAuthCookie: vi.fn(),
  CLIENT_SESSION_TOKEN: '__cookie_session__',
  validatePassword: () => null,
}));
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn(async () => 'password-hash') },
}));
vi.mock('next/navigation', () => ({ redirect: harness.redirect }));
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));
vi.mock('@/components/landing/LandingPage', () => ({ default: () => null }));
vi.mock('@/lib/siteSettings', () => ({
  getSiteSettings: vi.fn(async () => ({
    site_name: 'LectureLive',
    site_description: '',
    logo_path: '',
    allow_registration: true,
    language: 'en',
  })),
}));
vi.mock('@/lib/i18n/server', () => ({ detectServerLocale: vi.fn(async () => 'en') }));

import RootPage from '@/app/page';
import { POST } from '@/app/api/setup/route';

const BOOTSTRAP_TOKEN = 'bootstrap-token-for-e2e-flow-32-bytes-minimum';
const ORIGINAL_BOOTSTRAP_TOKEN = process.env.SETUP_BOOTSTRAP_TOKEN;

function setupRequest(step: string, extra: Record<string, unknown> = {}, token = false) {
  return new Request('http://localhost/api/setup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-setup-token': BOOTSTRAP_TOKEN } : {}),
    },
    body: JSON.stringify({ step, ...extra }),
  });
}

describe('bootstrap token -> homepage -> explicit ADMIN completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.adminCount = 0;
    harness.state.adminSession = false;
    harness.state.setupComplete = false;
    process.env.SETUP_BOOTSTRAP_TOKEN = BOOTSTRAP_TOKEN;
    harness.redirect.mockImplementation((url: string) => {
      throw new Error(`NEXT_REDIRECT:${url}`);
    });
  });

  afterEach(() => {
    if (ORIGINAL_BOOTSTRAP_TOKEN === undefined) {
      delete process.env.SETUP_BOOTSTRAP_TOKEN;
    } else {
      process.env.SETUP_BOOTSTRAP_TOKEN = ORIGINAL_BOOTSTRAP_TOKEN;
    }
  });

  it('首页不会因首管已创建而提前封门；只有 ADMIN complete 会写标记', async () => {
    const claim = await POST(
      setupRequest(
        'admin',
        {
          email: 'admin@example.com',
          password: 'StrongPass123',
          displayName: 'Admin',
        },
        true
      )
    );
    expect(claim.status).toBe(200);
    expect(harness.state.adminCount).toBe(1);
    expect(harness.state.setupComplete).toBe(false);
    expect(harness.siteSettingUpsert).not.toHaveBeenCalled();

    await expect(RootPage()).rejects.toThrow('NEXT_REDIRECT:/setup');
    expect(harness.state.setupComplete).toBe(false);
    expect(harness.siteSettingUpsert).not.toHaveBeenCalled();

    harness.state.adminSession = true;
    const complete = await POST(setupRequest('complete'));
    expect(complete.status).toBe(200);
    expect(harness.state.setupComplete).toBe(true);

    await expect(RootPage()).resolves.toBeTruthy();
    const setupCompleteWrites = harness.siteSettingUpsert.mock.calls.filter(
      ([args]) => args.where.key === 'setup_complete'
    );
    expect(setupCompleteWrites).toHaveLength(1);
  });
});
