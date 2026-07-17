'use client';

import { useCallback, useEffect, useState } from 'react';
import { X, Wallet, Clock, Crown, RefreshCw, ScrollText } from 'lucide-react';
import ModalPortal from '@/components/ModalPortal';
import { useExitAnimation } from '@/hooks/useExitAnimation';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAuth } from '@/hooks/useAuth';
import { useI18n } from '@/lib/i18n';
import { formatCurrencyCents } from '@/lib/format';

interface WalletInfo {
  walletBalanceCents: number;
  purchasedMinutesBalance: number;
  role: string;
  roleExpiresAt: string | null;
}
interface PublicConfig {
  enabled: boolean;
  currencySymbol: string;
  providers: string[];
}
interface Tier {
  id: string;
  kind: 'membership' | 'minutes' | 'topup';
  name: string;
  priceCents: number;
  grantRole: string | null;
  durationDays: number | null;
  grantMinutes: number | null;
  creditCents: number | null;
}
interface Txn {
  id: string;
  type: string;
  amountCents: number;
  balanceAfterCents: number;
  minutesDelta: number | null;
  note: string | null;
  createdAt: string;
}

type Tab = 'topup' | 'membership' | 'minutes' | 'history';

/**
 * 支付跳转返回处理：网关支付完成后浏览器带 `?recharge=success|cancel|failed` 回到应用，
 * 此组件读取并清理该参数；成功则刷新配额并打开充值弹窗展示最新余额。挂在 dashboard layout。
 */
export function RechargeReturnHandler() {
  const setOpen = useSettingsStore((s) => s.setRechargeOpen);
  const { fetchQuotas } = useAuth();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const r = params.get('recharge');
    if (!r) return;
    params.delete('recharge');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    if (r === 'success') {
      fetchQuotas();
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

export default function RechargeModal() {
  const open = useSettingsStore((s) => s.rechargeOpen);
  const setOpen = useSettingsStore((s) => s.setRechargeOpen);
  const { mounted, leaving } = useExitAnimation(open);
  const { token, fetchQuotas } = useAuth();
  const { t } = useI18n();

  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [tab, setTab] = useState<Tab>('topup');
  const [pendingPay, setPendingPay] = useState<string | null>(null); // tierId 等待选渠道
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const loadWallet = useCallback(async () => {
    const [meRes, tiersRes] = await Promise.all([
      fetch('/api/wallet/me', { headers: authHeaders }),
      fetch('/api/wallet/tiers', { headers: authHeaders }),
    ]);
    if (meRes.ok) {
      const d = await meRes.json();
      setWallet(d.wallet);
      setConfig(d.config);
    }
    if (tiersRes.ok) setTiers((await tiersRes.json()).tiers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const loadHistory = useCallback(async () => {
    const res = await fetch('/api/wallet/transactions', { headers: authHeaders });
    if (res.ok) setTxns((await res.json()).transactions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (open) {
      setMsg(null);
      setQr(null);
      setPendingPay(null);
      loadWallet();
    }
  }, [open, loadWallet]);

  useEffect(() => {
    if (open && tab === 'history') loadHistory();
  }, [open, tab, loadHistory]);

  if (!mounted) return null;

  const symbol = config?.currencySymbol ?? '¥';
  const providers = config?.providers ?? [];

  const buyWithBalance = async (tierId: string) => {
    setBusy(true);
    setMsg(null);
    const res = await fetch('/api/wallet/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ tierId, mode: 'balance' }),
    });
    setBusy(false);
    if (res.ok) {
      setMsg(t('recharge.buySuccess'));
      await loadWallet();
      await fetchQuotas();
    } else {
      setMsg((await res.json()).error ?? t('common.operationFailed'));
    }
  };

  const payOnline = async (tierId: string, provider: string) => {
    setBusy(true);
    setMsg(null);
    setQr(null);
    const res = await fetch('/api/wallet/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ tierId, mode: 'pay', provider }),
    });
    setBusy(false);
    setPendingPay(null);
    if (!res.ok) {
      setMsg((await res.json()).error ?? t('common.operationFailed'));
      return;
    }
    const d = await res.json();
    if (d.payUrl) {
      // 跳转支付页（支付宝/Stripe/沙箱）
      window.location.href = d.payUrl;
    } else if (d.qrCode) {
      // 扫码支付（微信）
      setQr(d.qrCode);
    }
  };

  const providerLabel = (p: string) =>
    p === 'alipay'
      ? t('recharge.provider_alipay')
      : p === 'wechat'
        ? t('recharge.provider_wechat')
        : p === 'stripe'
          ? t('recharge.provider_stripe')
          : t('recharge.provider_sandbox');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'topup', label: t('recharge.tabTopup') },
    { id: 'membership', label: t('recharge.tabMembership') },
    { id: 'minutes', label: t('recharge.tabMinutes') },
    { id: 'history', label: t('recharge.tabHistory') },
  ];

  const visibleTiers = tiers.filter((tr) => tr.kind === tab);

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[1100] flex items-center justify-center">
        <div
          className={`absolute inset-0 bg-black/30 backdrop-blur-sm ${leaving ? 'animate-backdrop-leave' : 'animate-backdrop-enter'}`}
          onClick={() => setOpen(false)}
        />
        <div
          className={`relative bg-cream-50 dark:bg-charcoal-900 rounded-2xl shadow-2xl border border-cream-200 dark:border-charcoal-700 w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col mx-4 ${leaving ? 'animate-modal-leave' : 'animate-modal-enter'}`}
        >
          {/* 标题栏 */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-cream-200 dark:border-charcoal-700 bg-white dark:bg-charcoal-800 flex-shrink-0">
            <h2 className="font-serif text-lg font-bold text-charcoal-800 dark:text-cream-100 flex items-center gap-2">
              <Wallet className="w-5 h-5 text-rust-500" />
              {t('recharge.title')}
            </h2>
            <button
              onClick={() => setOpen(false)}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-charcoal-400 hover:bg-cream-100 dark:hover:bg-charcoal-700 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-5">
            {config && !config.enabled ? (
              <p className="text-center text-charcoal-400 py-8">{t('recharge.disabled')}</p>
            ) : (
              <>
                {/* 概览卡 */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 p-4">
                    <div className="flex items-center gap-1.5 text-xs text-charcoal-400 mb-1">
                      <Wallet className="w-3.5 h-3.5" /> {t('recharge.balance')}
                    </div>
                    <div className="text-2xl font-bold text-charcoal-800 dark:text-cream-100">
                      {formatCurrencyCents(wallet?.walletBalanceCents ?? 0, symbol)}
                    </div>
                  </div>
                  <div className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 p-4">
                    <div className="flex items-center gap-1.5 text-xs text-charcoal-400 mb-1">
                      <Clock className="w-3.5 h-3.5" /> {t('recharge.minutesPool')}
                    </div>
                    <div className="text-2xl font-bold text-charcoal-800 dark:text-cream-100">
                      {wallet?.purchasedMinutesBalance ?? 0}
                      <span className="text-sm font-normal text-charcoal-400 ml-1">{t('recharge.min')}</span>
                    </div>
                  </div>
                  <div className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 p-4">
                    <div className="flex items-center gap-1.5 text-xs text-charcoal-400 mb-1">
                      <Crown className="w-3.5 h-3.5" /> {wallet?.role ?? 'FREE'}
                    </div>
                    <div className="text-sm text-charcoal-600 dark:text-cream-300">
                      {wallet?.roleExpiresAt
                        ? `${t('recharge.expiresOn')} ${new Date(wallet.roleExpiresAt).toLocaleDateString()}`
                        : t('recharge.permanent')}
                    </div>
                  </div>
                </div>

                {/* 子 tab */}
                <div className="flex gap-1 bg-cream-100 dark:bg-charcoal-800 rounded-lg p-1">
                  {tabs.map((tb) => (
                    <button
                      key={tb.id}
                      onClick={() => {
                        setTab(tb.id);
                        setPendingPay(null);
                        setQr(null);
                      }}
                      className={`flex-1 py-1.5 rounded-md text-sm font-medium transition-colors ${
                        tab === tb.id
                          ? 'bg-white dark:bg-charcoal-700 text-rust-600 shadow-sm'
                          : 'text-charcoal-500 hover:text-charcoal-700 dark:hover:text-cream-300'
                      }`}
                    >
                      {tb.label}
                    </button>
                  ))}
                </div>

                {msg && (
                  <div className="text-sm text-center text-rust-600 bg-rust-50 dark:bg-rust-500/10 rounded-lg py-2">
                    {msg}
                  </div>
                )}

                {qr && (
                  <div className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 p-4 text-center">
                    <p className="text-sm text-charcoal-600 dark:text-cream-300 mb-2">
                      {t('recharge.wechatScanHint')}
                    </p>
                    <code className="block text-xs break-all text-charcoal-400 bg-cream-50 dark:bg-charcoal-900 rounded p-2">
                      {qr}
                    </code>
                  </div>
                )}

                {/* 历史 */}
                {tab === 'history' ? (
                  <div className="space-y-2">
                    {txns.length === 0 && (
                      <p className="text-center text-charcoal-400 py-6 flex items-center justify-center gap-2">
                        <ScrollText className="w-4 h-4" /> {t('recharge.historyEmpty')}
                      </p>
                    )}
                    {txns.map((tx) => (
                      <div
                        key={tx.id}
                        className="flex items-center justify-between bg-white dark:bg-charcoal-800 rounded-lg border border-cream-200 dark:border-charcoal-700 px-4 py-2.5"
                      >
                        <div>
                          <div className="text-sm font-medium text-charcoal-700 dark:text-cream-200">
                            {t(`adminRecharge.txType_${tx.type}`) || tx.type}
                          </div>
                          <div className="text-xs text-charcoal-400">
                            {new Date(tx.createdAt).toLocaleString()}
                            {tx.note ? ` · ${tx.note}` : ''}
                          </div>
                        </div>
                        <div className={`text-sm font-semibold ${tx.amountCents >= 0 ? 'text-green-600' : 'text-rust-600'}`}>
                          {formatCurrencyCents(tx.amountCents, symbol)}
                          {tx.minutesDelta ? ` · ${tx.minutesDelta > 0 ? '+' : ''}${tx.minutesDelta}m` : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  /* 档位列表 */
                  <div className="space-y-3">
                    {visibleTiers.length === 0 && (
                      <p className="text-center text-charcoal-400 py-6">{t('recharge.noTiers')}</p>
                    )}
                    {visibleTiers.map((tr) => (
                      <div
                        key={tr.id}
                        className="bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700 p-4"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="font-medium text-charcoal-800 dark:text-cream-100">{tr.name}</div>
                            <div className="text-xs text-charcoal-400">
                              {tr.kind === 'membership' &&
                                `${tr.grantRole} · ${tr.durationDays}${t('recharge.days')}`}
                              {tr.kind === 'minutes' && `+${tr.grantMinutes} ${t('recharge.min')}`}
                              {tr.kind === 'topup' &&
                                `${t('recharge.credited')} ${formatCurrencyCents(tr.creditCents ?? tr.priceCents, symbol)}`}
                            </div>
                          </div>
                          <div className="text-lg font-bold text-rust-600">
                            {formatCurrencyCents(tr.priceCents, symbol)}
                          </div>
                        </div>

                        {pendingPay === tr.id ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {providers.length === 0 && (
                              <span className="text-xs text-charcoal-400">{t('recharge.noProviders')}</span>
                            )}
                            {providers.map((p) => (
                              <button
                                key={p}
                                disabled={busy}
                                onClick={() => payOnline(tr.id, p)}
                                className="px-3 py-1.5 rounded-lg bg-rust-500 text-white text-sm hover:bg-rust-600 disabled:opacity-50"
                              >
                                {providerLabel(p)}
                              </button>
                            ))}
                            <button
                              onClick={() => setPendingPay(null)}
                              className="px-3 py-1.5 rounded-lg border border-cream-300 dark:border-charcoal-600 text-sm text-charcoal-500"
                            >
                              {t('common.cancel')}
                            </button>
                          </div>
                        ) : (
                          <div className="mt-3 flex gap-2">
                            {tr.kind !== 'topup' && (
                              <button
                                disabled={busy}
                                onClick={() => buyWithBalance(tr.id)}
                                className="px-3 py-1.5 rounded-lg border border-rust-300 text-rust-600 text-sm hover:bg-rust-50 dark:hover:bg-rust-500/10 disabled:opacity-50"
                              >
                                {t('recharge.buyWithBalance')}
                              </button>
                            )}
                            <button
                              disabled={busy || providers.length === 0}
                              onClick={() => setPendingPay(tr.id)}
                              className="px-3 py-1.5 rounded-lg bg-rust-500 text-white text-sm hover:bg-rust-600 disabled:opacity-50"
                            >
                              {t('recharge.payOnline')}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex justify-center">
                  <button
                    onClick={() => {
                      loadWallet();
                      if (tab === 'history') loadHistory();
                    }}
                    className="inline-flex items-center gap-1.5 text-xs text-charcoal-400 hover:text-charcoal-600"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> {t('common.refresh')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
