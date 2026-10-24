import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RechargeModal：下单请求抛错（断网/超时）后必须释放 busy。此前 fetch 抛错会跳过
 * setBusy(false)，弹窗常驻挂在 dashboard layout 里不卸载，所有购买按钮一直禁用到整页刷新。
 */

const stableT = (key: string) => key;
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: stableT, locale: 'zh', setLocale: () => {} }),
}));
const fetchQuotas = vi.fn(async () => {});
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ token: 'test-token', fetchQuotas }),
}));

const memStorage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string) => memStorage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memStorage.set(k, String(v));
    },
    removeItem: (k: string) => {
      memStorage.delete(k);
    },
    clear: () => memStorage.clear(),
    key: () => null,
    length: 0,
  },
});

const { default: RechargeModal } = await import('@/components/RechargeModal');
const { useSettingsStore } = await import('@/stores/settingsStore');

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('RechargeModal busy 释放', () => {
  beforeEach(() => {
    memStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/wallet/me')) {
          return jsonRes({
            wallet: { walletBalanceCents: 10_000, purchasedMinutesBalance: 0, role: 'FREE', roleExpiresAt: null },
            config: { enabled: true, currencySymbol: '¥', providers: ['alipay'] },
          });
        }
        if (url.includes('/api/wallet/tiers')) {
          return jsonRes({
            tiers: [
              {
                id: 'm1',
                kind: 'membership',
                name: 'Pro 月卡',
                priceCents: 3_000,
                grantRole: 'PRO',
                durationDays: 30,
                grantMinutes: null,
                creditCents: null,
              },
            ],
          });
        }
        if (url.includes('/api/wallet/checkout')) {
          throw new TypeError('Failed to fetch');
        }
        return jsonRes({});
      })
    );
    useSettingsStore.setState({ rechargeOpen: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useSettingsStore.setState({ rechargeOpen: false });
  });

  it('余额购买请求抛错后按钮恢复可用，并提示网络错误', async () => {
    const user = userEvent.setup();
    render(<RechargeModal />);

    await user.click(await screen.findByText('recharge.tabMembership'));
    const buy = await screen.findByRole('button', { name: 'recharge.buyWithBalance' });
    await user.click(buy);

    await waitFor(() => {
      expect(screen.getByText('common.networkError')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'recharge.buyWithBalance' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'recharge.payOnline' })).not.toBeDisabled();
  });

  it('在线支付下单请求抛错后按钮恢复可用', async () => {
    const user = userEvent.setup();
    render(<RechargeModal />);

    await user.click(await screen.findByText('recharge.tabMembership'));
    await user.click(await screen.findByRole('button', { name: 'recharge.payOnline' }));
    await user.click(await screen.findByRole('button', { name: 'recharge.provider_alipay' }));

    await waitFor(() => {
      expect(screen.getByText('common.networkError')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'recharge.provider_alipay' })).not.toBeDisabled();
  });
});
