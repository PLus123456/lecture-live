import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import SessionAuthRecovery from '@/components/session/SessionAuthRecovery';

describe('SessionAuthRecovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not restore a confirmed anonymous session', async () => {
    const restoreSession = vi.fn(async () => 'restored' as const);

    render(
      <SessionAuthRecovery
        sessionChecked
        restoreSession={restoreSession}
        pendingMessage="pending"
      />
    );

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login'));
    expect(restoreSession).not.toHaveBeenCalled();
  });

  it('shows a recoverable unavailable state and retries', async () => {
    const restoreSession = vi
      .fn()
      .mockResolvedValueOnce('unavailable')
      .mockResolvedValueOnce('restored');
    const user = userEvent.setup();

    render(
      <SessionAuthRecovery
        sessionChecked={false}
        restoreSession={restoreSession}
        pendingMessage="pending"
      />
    );

    expect(
      await screen.findByText('auth.sessionServiceUnavailable')
    ).toBeTruthy();
    expect(mocks.replace).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'common.retry' }));

    await waitFor(() => expect(restoreSession).toHaveBeenCalledTimes(2));
    expect(screen.getByText('pending')).toBeTruthy();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('routes an invalid recovery to login', async () => {
    const restoreSession = vi.fn(async () => 'invalid' as const);

    render(
      <SessionAuthRecovery
        sessionChecked={false}
        restoreSession={restoreSession}
        pendingMessage="pending"
      />
    );

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login'));
    expect(restoreSession).toHaveBeenCalledTimes(1);
  });

  it('coalesces the development StrictMode effect replay', async () => {
    const restoreSession = vi.fn(async () => 'unavailable' as const);

    render(
      <StrictMode>
        <SessionAuthRecovery
          sessionChecked={false}
          restoreSession={restoreSession}
          pendingMessage="pending"
        />
      </StrictMode>
    );

    expect(
      await screen.findByText('auth.sessionServiceUnavailable')
    ).toBeTruthy();
    expect(restoreSession).toHaveBeenCalledTimes(1);
  });

  it('does not treat the successful setAuth transition as a logout', async () => {
    let resolveRestore: ((result: 'restored') => void) | undefined;
    const restoreSession = vi.fn(
      () =>
        new Promise<'restored'>((resolve) => {
          resolveRestore = resolve;
        })
    );
    const view = render(
      <SessionAuthRecovery
        sessionChecked={false}
        restoreSession={restoreSession}
        pendingMessage="pending"
      />
    );

    await waitFor(() => expect(restoreSession).toHaveBeenCalledTimes(1));
    // authStore.setAuth temporarily publishes this state while clearing the
    // previous account's stores, before committing the recovered user/token.
    view.rerender(
      <SessionAuthRecovery
        sessionChecked
        restoreSession={restoreSession}
        pendingMessage="pending"
      />
    );
    expect(mocks.replace).not.toHaveBeenCalled();

    resolveRestore?.('restored');
    await Promise.resolve();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('routes after an in-flight recovery is made stale by logout', async () => {
    let resolveRestore: ((result: 'stale') => void) | undefined;
    const restoreSession = vi.fn(
      () =>
        new Promise<'stale'>((resolve) => {
          resolveRestore = resolve;
        })
    );
    const view = render(
      <SessionAuthRecovery
        sessionChecked={false}
        restoreSession={restoreSession}
        pendingMessage="pending"
      />
    );

    await waitFor(() => expect(restoreSession).toHaveBeenCalledTimes(1));
    view.rerender(
      <SessionAuthRecovery
        sessionChecked
        restoreSession={restoreSession}
        pendingMessage="pending"
      />
    );
    expect(mocks.replace).not.toHaveBeenCalled();

    resolveRestore?.('stale');
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login'));
    expect(
      screen.queryByText('auth.sessionServiceUnavailable')
    ).toBeNull();
  });
});
