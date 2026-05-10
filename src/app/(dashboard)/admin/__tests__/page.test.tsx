import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Router mocks (allow tests to control searchParams + capture replace calls) ───
const replaceMock = vi.fn();
let currentSearch = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: (url: string, options?: unknown) => {
      replaceMock(url, options);
      // Mirror next/navigation behavior — update internal search state so the
      // component re-reads the same params on re-render.
      const qIdx = url.indexOf('?');
      currentSearch = qIdx >= 0 ? url.slice(qIdx + 1) : '';
    },
  }),
  usePathname: () => '/admin',
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: {
      id: 'admin-1',
      email: 'admin@test',
      displayName: 'Admin',
      role: 'ADMIN',
    },
  }),
}));

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

vi.mock('@/lib/i18n', async () => {
  const actual = await vi.importActual<typeof import('@/lib/i18n')>('@/lib/i18n');
  return {
    ...actual,
    useI18n: () => ({ t: actual.getTranslation('en'), locale: 'en', setLocale: () => {} }),
  };
});

// Stub heavy admin panels — we're testing the AdminPage routing, not the panels themselves.
vi.mock('@/components/admin/DashboardPanel', () => ({
  default: () => <div data-testid="panel-dashboard">DASH</div>,
}));
vi.mock('@/components/admin/SettingsPanel', () => ({
  default: () => <div data-testid="panel-settings">SET</div>,
}));
vi.mock('@/components/admin/UserGroupsPanel', () => ({
  default: () => <div data-testid="panel-groups">GROUPS</div>,
}));
vi.mock('@/components/admin/UserManagementPanel', () => ({
  default: () => <div data-testid="panel-users">USERS</div>,
}));
vi.mock('@/components/admin/AuditLogPanel', () => ({
  default: () => <div data-testid="panel-logs">LOGS</div>,
}));
vi.mock('@/components/admin/ReconciliationPanel', () => ({
  default: () => <div data-testid="panel-reconciliation">REC</div>,
}));
vi.mock('@/components/admin/JobQueuePanel', () => ({
  default: () => <div data-testid="panel-jobs">JOBS</div>,
}));
vi.mock('@/components/SiteLogo', () => ({ default: () => <div /> }));

import AdminPage from '@/app/(dashboard)/admin/page';

beforeEach(() => {
  replaceMock.mockClear();
  currentSearch = '';
});

afterEach(() => {
  currentSearch = '';
});

describe('AdminPage URL state', () => {
  it('默认显示 dashboard tab（无 query 参数）', () => {
    render(<AdminPage />);
    expect(screen.getByTestId('panel-dashboard')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-settings')).not.toBeInTheDocument();
  });

  it('?tab=settings 时显示 Settings 面板', () => {
    currentSearch = 'tab=settings';
    render(<AdminPage />);
    expect(screen.getByTestId('panel-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-dashboard')).not.toBeInTheDocument();
  });

  it('?tab=users 时显示 Users 面板', () => {
    currentSearch = 'tab=users';
    render(<AdminPage />);
    expect(screen.getByTestId('panel-users')).toBeInTheDocument();
  });

  it('点击 tab 通过 router.replace 写入 URL（非默认 tab 写 query 参数）', async () => {
    const user = userEvent.setup();
    render(<AdminPage />);
    await user.click(screen.getByRole('button', { name: /User Groups/i }));
    expect(replaceMock).toHaveBeenCalledWith('/admin?tab=groups', expect.anything());
  });

  it('回到 dashboard 时清掉 tab query', async () => {
    currentSearch = 'tab=users';
    const user = userEvent.setup();
    render(<AdminPage />);
    await user.click(screen.getByRole('button', { name: /Dashboard/i }));
    // dashboard 是默认 tab，URL 应该裸路径
    expect(replaceMock).toHaveBeenCalledWith('/admin', expect.anything());
  });

  it('切换主 tab 时清掉残留的 subtab', async () => {
    currentSearch = 'tab=settings&subtab=email';
    const user = userEvent.setup();
    render(<AdminPage />);
    await user.click(screen.getByRole('button', { name: /User Groups/i }));
    const url = replaceMock.mock.calls[0][0] as string;
    expect(url).not.toContain('subtab');
    expect(url).toContain('tab=groups');
  });

  it('未知 tab 值回退到 dashboard', () => {
    currentSearch = 'tab=hacker';
    render(<AdminPage />);
    expect(screen.getByTestId('panel-dashboard')).toBeInTheDocument();
  });
});
