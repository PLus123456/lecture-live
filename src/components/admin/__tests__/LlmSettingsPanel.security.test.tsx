import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/stores/toastStore', () => ({
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock,
  },
}));

vi.mock('@/components/ModalPortal', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { GatewayModal } from '@/components/admin/LlmSettingsPanel';

const EXISTING_GATEWAY = {
  id: 'provider-1',
  name: 'Vendor',
  apiBase: 'https://api.vendor.example/v1',
  isAnthropic: false,
  hasApiKey: true,
  maskedApiKey: 'sk-••••1234',
  endpointRedacted: false,
  registryModels: [],
  routes: [],
};

describe('GatewayModal SEC-034 reauthentication contract', () => {
  beforeEach(() => {
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires and submits currentPassword when creating a gateway', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ provider: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn().mockResolvedValue(undefined);

    render(<GatewayModal onClose={vi.fn()} onSaved={onSaved} />);

    await user.type(
      screen.getByPlaceholderText('adminSettings.providerNamePlaceholder'),
      'Vendor'
    );
    await user.type(screen.getByPlaceholderText('https://api.example.com/v1'), 'https://api.vendor.example/v1');
    await user.type(screen.getByPlaceholderText('sk-...'), 'fresh-key');
    const passwordInput = screen.getByPlaceholderText(
      'settings.currentPasswordPlaceholder'
    );
    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(passwordInput).toHaveAttribute('autocomplete', 'current-password');
    await user.type(passwordInput, 'admin-password');
    await user.click(screen.getByText('common.save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: 'Vendor',
      apiBase: 'https://api.vendor.example/v1',
      apiKey: 'fresh-key',
      currentPassword: 'admin-password',
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('does not request or submit a password for an ordinary rename', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ provider: {} }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <GatewayModal
        gateway={EXISTING_GATEWAY}
        onClose={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(
      screen.queryByPlaceholderText('settings.currentPasswordPlaceholder')
    ).not.toBeInTheDocument();
    const nameInput = screen.getByDisplayValue('Vendor');
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed Vendor');
    await user.click(screen.getByText('common.save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/llm-providers/provider-1');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.name).toBe('Renamed Vendor');
    expect(body).not.toHaveProperty('currentPassword');
    expect(body).not.toHaveProperty('apiKey');
  });

  it('reveals the password gate and submits a fresh key when the endpoint is retargeted', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ provider: {} }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <GatewayModal
        gateway={EXISTING_GATEWAY}
        onClose={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const endpointInput = screen.getByDisplayValue(EXISTING_GATEWAY.apiBase);
    await user.clear(endpointInput);
    await user.type(endpointInput, 'https://api.newvendor.example/v1');
    await user.type(screen.getByPlaceholderText('••••••••'), 'replacement-key');
    await user.type(
      screen.getByPlaceholderText('settings.currentPasswordPlaceholder'),
      'admin-password'
    );
    await user.click(screen.getByText('common.save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      apiBase: 'https://api.newvendor.example/v1',
      apiKey: 'replacement-key',
      currentPassword: 'admin-password',
    });
  });
});
