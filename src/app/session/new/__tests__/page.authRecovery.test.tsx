import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  restoreSession: vi.fn(),
  useMicrophoneMonitor: vi.fn(),
  resolveSessionTerms: vi.fn(),
  auth: {
    user: null as { id: string } | null,
    token: null as string | null,
    sessionChecked: true,
  },
  settings: {
    sidebarCollapsed: false,
    audioSource: 'mic',
    preferredMicDeviceId: null,
    sourceLang: 'en',
    targetLang: 'zh',
    sonioxRegionPreference: 'us',
    topic: '',
    terms: [] as string[],
    llmProvider: '',
    setAudioSource: vi.fn(),
    setPreferredMicDeviceId: vi.fn(),
    setSourceLang: vi.fn(),
    setTargetLang: vi.fn(),
    setSonioxRegionPreference: vi.fn(),
    setTopic: vi.fn(),
    setPendingAutoStart: vi.fn(),
    setPendingSessionTerms: vi.fn(),
    setPendingSystemStream: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    ...mocks.auth,
    restoreSession: mocks.restoreSession,
  }),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/hooks/useMicrophoneMonitor', () => ({
  useMicrophoneMonitor: mocks.useMicrophoneMonitor,
}));

vi.mock('@/lib/keywords/sessionTerms', () => ({
  resolveSessionTerms: mocks.resolveSessionTerms,
}));

vi.mock('@/lib/clientAccountCleanup', () => ({
  clearAccountBoundClientState: vi.fn(async () => undefined),
}));

vi.mock('@/components/Sidebar', () => ({ default: () => null }));
vi.mock('@/components/UserSettingsModal', () => ({ default: () => null }));
vi.mock('@/components/LanguageSelect', () => ({ default: () => null }));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: typeof mocks.settings) => unknown) =>
    selector(mocks.settings),
}));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import NewSessionPage from '@/app/session/new/page';
import { useAuthStore } from '@/stores/authStore';

const AUTH_USER_A = {
  id: 'user-a',
  email: 'a@example.com',
  displayName: 'A',
  role: 'FREE' as const,
  createdAt: '2026-08-20T00:00:00.000Z',
};
const AUTH_USER_B = {
  ...AUTH_USER_A,
  id: 'user-b',
  email: 'b@example.com',
};

describe('NewSessionPage authentication recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    });
    mocks.auth.user = null;
    mocks.auth.token = null;
    mocks.auth.sessionChecked = true;
    mocks.restoreSession.mockResolvedValue('restored');
    mocks.resolveSessionTerms.mockResolvedValue([]);
    mocks.useMicrophoneMonitor.mockReturnValue({
      activeDeviceId: null,
      availableMics: [],
      bars: [],
      error: null,
      level: 0,
      peakDb: null,
      placeholderLabel: '',
      permissionState: 'idle',
      requestAccess: vi.fn(),
    });
  });

  it('does not restore or capture the microphone after explicit logout', async () => {
    render(<NewSessionPage />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login'));
    expect(mocks.restoreSession).not.toHaveBeenCalled();
    expect(mocks.useMicrophoneMonitor).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });

  it('renders retry UI when cookie recovery is temporarily unavailable', async () => {
    mocks.auth.sessionChecked = false;
    mocks.restoreSession
      .mockResolvedValueOnce('unavailable')
      .mockResolvedValueOnce('restored');
    const user = userEvent.setup();

    render(<NewSessionPage />);

    expect(
      await screen.findByText('auth.sessionServiceUnavailable')
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'common.retry' }));
    await waitFor(() => expect(mocks.restoreSession).toHaveBeenCalledTimes(2));
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('does not resurrect A pending session data after B finishes account cleanup', async () => {
    mocks.auth.user = AUTH_USER_A;
    mocks.auth.token = '__cookie_session__';
    mocks.auth.sessionChecked = true;
    useAuthStore.setState({
      user: AUTH_USER_A,
      token: '__cookie_session__',
      sessionBinding: 'binding-a',
      quotas: null,
      sessionChecked: true,
    });
    localStorage.setItem(
      'lecture-live-auth',
      JSON.stringify({
        state: {
          user: AUTH_USER_A,
          sessionBinding: 'binding-a',
          quotas: null,
        },
        version: 0,
      })
    );
    let releaseTerms!: () => void;
    mocks.resolveSessionTerms.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          releaseTerms = () => resolve(['a-private-term']);
        })
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/folders')) {
        return new Response('[]', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/sessions')) {
        return new Response(JSON.stringify({ id: 'session-a' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<NewSessionPage />);

    await user.click(
      screen.getByRole('button', {
        name: 'session.newSession.startRecording',
      })
    );
    await waitFor(() => expect(mocks.resolveSessionTerms).toHaveBeenCalled());
    await useAuthStore.getState().setAuth(
      AUTH_USER_B,
      '__cookie_session__',
      { sessionBinding: 'binding-b' }
    );
    await act(async () => {
      releaseTerms();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.settings.setPendingSessionTerms).not.toHaveBeenCalled();
    expect(mocks.settings.setPendingAutoStart).not.toHaveBeenCalled();
    expect(mocks.settings.setPendingSystemStream).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalledWith('/session/session-a');
  });
});
