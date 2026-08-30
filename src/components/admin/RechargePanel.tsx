'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Settings as SettingsIcon,
  Layers,
  ScrollText,
  Plus,
  Trash2,
  Pencil,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Save,
  X,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';
import { formatCurrencyCents } from '@/lib/format';
import {
  buildAdminTierMutation,
  isForbiddenAdminTier,
  prepareTierForAdminEdit,
  PURCHASABLE_MEMBERSHIP_ROLES,
} from '@/lib/payment/tierPolicy';

// ─── 类型 ───
interface RechargeSettings {
  enabled: boolean;
  /** ISO-4217 结算币种码（下拉选择，非自由文本）。见 CURRENCY_OPTIONS。 */
  currency?: string;
  currencySymbol: string;
  alipayEnabled: boolean;
  wechatEnabled: boolean;
  stripeEnabled: boolean;
  sandboxEnabled: boolean;
  alipayAppId: string;
  alipayPrivateKey: string;
  alipayPublicKey: string;
  alipaySellerId: string;
  alipayGateway: string;
  wechatAppId: string;
  wechatMchId: string;
  wechatApiV3Key: string;
  wechatSerialNo: string;
  wechatPrivateKey: string;
  wechatPlatformCert: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  stripePublishableKey: string;
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
  active: boolean;
  sortOrder: number;
}

interface Order {
  id: string;
  userEmail: string | null;
  provider: string;
  kind: string;
  amountCents: number;
  status: string;
  outTradeNo: string;
  createdAt: string;
}

interface Transaction {
  id: string;
  userEmail: string | null;
  type: string;
  amountCents: number;
  balanceAfterCents: number;
  minutesDelta: number | null;
  note: string | null;
  createdAt: string;
}

type SubTab = 'settings' | 'tiers' | 'ledger';

/**
 * 结算币种候选（ISO-4217 码 + 展示符号）。
 *
 * 币种从前是一个自由文本的「货币符号」框，Stripe 侧再拿它反推币种、推不出就落 usd —— 管理员
 * 填「元 / CNY / RMB」即静默按美元收款，约 7.1× 超收（P3-15）。这里改成下拉：码是唯一真源，
 * 符号随码确定，人手打不出非法值。
 */
const CURRENCY_OPTIONS: { code: string; symbol: string; label: string }[] = [
  { code: 'CNY', symbol: '¥', label: 'CNY · 人民币' },
  { code: 'USD', symbol: '$', label: 'USD · US Dollar' },
  { code: 'EUR', symbol: '€', label: 'EUR · Euro' },
  { code: 'GBP', symbol: '£', label: 'GBP · Pound' },
  { code: 'JPY', symbol: '¥', label: 'JPY · Yen' },
  { code: 'HKD', symbol: 'HK$', label: 'HKD · HK Dollar' },
  { code: 'TWD', symbol: 'NT$', label: 'TWD · New Taiwan Dollar' },
  { code: 'SGD', symbol: 'S$', label: 'SGD · Singapore Dollar' },
  { code: 'AUD', symbol: 'A$', label: 'AUD · Australian Dollar' },
  { code: 'CAD', symbol: 'C$', label: 'CAD · Canadian Dollar' },
];

const CARD = 'bg-white dark:bg-charcoal-800 rounded-xl border border-cream-200 dark:border-charcoal-700';
const INPUT =
  'w-full px-3 py-2 rounded-lg border border-cream-300 dark:border-charcoal-600 bg-white dark:bg-charcoal-900 text-sm text-charcoal-800 dark:text-cream-100 focus:outline-none focus:ring-2 focus:ring-rust-300';
const LABEL = 'block text-xs font-medium text-charcoal-500 dark:text-cream-400 mb-1';
const BTN_PRIMARY =
  'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-rust-500 text-white text-sm font-medium hover:bg-rust-600 disabled:opacity-50 transition-colors';
const BTN_GHOST =
  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cream-300 dark:border-charcoal-600 text-sm text-charcoal-600 dark:text-cream-300 hover:bg-cream-50 dark:hover:bg-charcoal-700 transition-colors';

export default function RechargePanel() {
  const { t } = useI18n();
  const [sub, setSub] = useState<SubTab>('settings');

  const subs: { id: SubTab; label: string; icon: typeof SettingsIcon }[] = [
    { id: 'settings', label: t('adminRecharge.subSettings'), icon: SettingsIcon },
    { id: 'tiers', label: t('adminRecharge.subTiers'), icon: Layers },
    { id: 'ledger', label: t('adminRecharge.subLedger'), icon: ScrollText },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-serif font-bold text-charcoal-800 dark:text-cream-100">
          {t('adminRecharge.title')}
        </h2>
        <p className="text-sm text-charcoal-400 dark:text-cream-500">{t('adminRecharge.subtitle')}</p>
      </div>

      <div className="flex gap-2 border-b border-cream-200 dark:border-charcoal-700">
        {subs.map((s) => {
          const Icon = s.icon;
          const active = sub === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setSub(s.id)}
              className={`inline-flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? 'border-rust-500 text-rust-600'
                  : 'border-transparent text-charcoal-400 hover:text-charcoal-600 dark:hover:text-cream-300'
              }`}
            >
              <Icon className="w-4 h-4" />
              {s.label}
            </button>
          );
        })}
      </div>

      {sub === 'settings' && <SettingsSection />}
      {sub === 'tiers' && <TiersSection />}
      {sub === 'ledger' && <LedgerSection />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 渠道设置
// ─────────────────────────────────────────────────────────────────────────────
function SettingsSection() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const [settings, setSettings] = useState<RechargeSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/recharge/settings', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) setSettings((await res.json()).settings);
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setMsg(null);
    const res = await fetch('/api/admin/recharge/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(settings),
    });
    setSaving(false);
    if (res.ok) {
      setSettings((await res.json()).settings);
      setMsg(t('common.saved'));
    } else {
      setMsg(t('common.saveFailed'));
    }
  };

  if (!settings) return <div className="text-sm text-charcoal-400 py-8">{t('common.loading')}</div>;

  const set = <K extends keyof RechargeSettings>(k: K, v: RechargeSettings[K]) =>
    setSettings({ ...settings, [k]: v });

  // label 与 input 用 htmlFor/id 绑定：此前两者毫无关联，读屏软件念不出字段名，
  // 测试也只能靠位置去点。id 取配置键，天然唯一且稳定。
  const field = (label: string, key: keyof RechargeSettings, secret = false) => (
    <div>
      <label className={LABEL} htmlFor={`recharge-${key}`}>
        {label}
      </label>
      <input
        id={`recharge-${key}`}
        type={secret ? 'password' : 'text'}
        className={INPUT}
        value={String(settings[key] ?? '')}
        placeholder={secret ? '••••••••' : ''}
        onChange={(e) => set(key, e.target.value as RechargeSettings[typeof key])}
      />
    </div>
  );

  // 现有配置里的币种码；老站点只存过符号（无 currency 键）时按符号回推一次，回推不出落 CNY。
  const currencyCode =
    CURRENCY_OPTIONS.find((c) => c.code === (settings.currency ?? '').toUpperCase())?.code ??
    CURRENCY_OPTIONS.find((c) => c.symbol === settings.currencySymbol)?.code ??
    'CNY';

  const toggle = (label: string, key: keyof RechargeSettings, desc?: string) => (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={Boolean(settings[key])}
        onChange={(e) => set(key, e.target.checked as RechargeSettings[typeof key])}
        className="mt-0.5 accent-rust-500"
      />
      <span>
        <span className="text-sm font-medium text-charcoal-700 dark:text-cream-200">{label}</span>
        {desc && <span className="block text-xs text-charcoal-400">{desc}</span>}
      </span>
    </label>
  );

  return (
    <div className="space-y-4">
      <div className={`${CARD} p-4 space-y-4`}>
        <div className="flex items-center justify-between">
          {toggle(t('adminRecharge.masterEnable'), 'enabled', t('adminRecharge.masterEnableDesc'))}
          <div className="w-48">
            <label className={LABEL} htmlFor="recharge-currency">
              {t('adminRecharge.currencyCode')}
            </label>
            <select
              id="recharge-currency"
              className={INPUT}
              value={currencyCode}
              onChange={(e) => {
                // 码与符号一起写：符号只是展示派生物，绝不允许它和结算币种各说各话。
                const picked =
                  CURRENCY_OPTIONS.find((c) => c.code === e.target.value) ?? CURRENCY_OPTIONS[0];
                setSettings({
                  ...settings,
                  currency: picked.code,
                  currencySymbol: picked.symbol,
                });
              }}
            >
              {CURRENCY_OPTIONS.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="block text-xs text-charcoal-400 mt-1">
              {t('adminRecharge.currencyCodeDesc')}
            </span>
          </div>
        </div>
      </div>

      {/* Sandbox */}
      <div className={`${CARD} p-4 space-y-3`}>
        {toggle(t('adminRecharge.sandbox'), 'sandboxEnabled', t('adminRecharge.sandboxDesc'))}
      </div>

      {/* Stripe */}
      <div className={`${CARD} p-4 space-y-3`}>
        {toggle('Stripe', 'stripeEnabled')}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {field(t('adminRecharge.stripeSecretKey'), 'stripeSecretKey', true)}
          {field(t('adminRecharge.stripeWebhookSecret'), 'stripeWebhookSecret', true)}
          {field(t('adminRecharge.stripePublishableKey'), 'stripePublishableKey')}
        </div>
      </div>

      {/* 支付宝 */}
      <div className={`${CARD} p-4 space-y-3`}>
        {toggle(t('adminRecharge.alipay'), 'alipayEnabled')}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {field('App ID', 'alipayAppId')}
          {field(t('adminRecharge.alipayGateway'), 'alipayGateway')}
          {field(t('adminRecharge.alipayPrivateKey'), 'alipayPrivateKey', true)}
          {field(t('adminRecharge.alipayPublicKey'), 'alipayPublicKey')}
          {/* L17：seller_id 绑定。代码侧已强制（alipay.ts 收到不匹配的 seller_id 直接拒绝到账），
              此前没有入口 → 只能手改 DB 行才能启用，等于这道校验默认永远是关的。 */}
          {field(t('adminRecharge.alipaySellerId'), 'alipaySellerId')}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t('adminRecharge.alipaySellerIdHint')}
        </p>
      </div>

      {/* 微信 */}
      <div className={`${CARD} p-4 space-y-3`}>
        {toggle(t('adminRecharge.wechat'), 'wechatEnabled')}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {field('App ID', 'wechatAppId')}
          {field(t('adminRecharge.wechatMchId'), 'wechatMchId')}
          {field(t('adminRecharge.wechatSerialNo'), 'wechatSerialNo')}
          {field(t('adminRecharge.wechatApiV3Key'), 'wechatApiV3Key', true)}
          {field(t('adminRecharge.wechatPrivateKey'), 'wechatPrivateKey', true)}
          {field(t('adminRecharge.wechatPlatformCert'), 'wechatPlatformCert')}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button className={BTN_PRIMARY} onClick={save} disabled={saving}>
          <Save className="w-4 h-4" />
          {saving ? t('common.saving') : t('common.save')}
        </button>
        {msg && <span className="text-sm text-charcoal-500">{msg}</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 档位管理
// ─────────────────────────────────────────────────────────────────────────────
const EMPTY_TIER: Partial<Tier> = {
  kind: 'topup',
  name: '',
  priceCents: 0,
  grantRole: 'PRO',
  durationDays: 30,
  grantMinutes: 60,
  // 不能是 0（P3-13）：0 会被当成「到账 0 元」原样提交，建出一个收全款却一分不到账的档位。
  // undefined = 「没填」，后端据此回落成 creditCents = priceCents。
  creditCents: undefined,
  active: true,
  sortOrder: 0,
};

function TiersSection() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [editing, setEditing] = useState<Partial<Tier> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/recharge/tiers', { headers: auth });
    if (res.ok) setTiers((await res.json()).tiers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!editing) return;
    setError(null);
    const method = editing.id ? 'PATCH' : 'POST';
    const payload = buildAdminTierMutation(editing);
    const res = await fetch('/api/admin/recharge/tiers', {
      method,
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      setEditing(null);
      load();
    } else {
      setError((await res.json()).error ?? t('common.saveFailed'));
    }
  };

  const del = async (id: string) => {
    if (!confirm(t('adminRecharge.confirmDeleteTier'))) return;
    await fetch(`/api/admin/recharge/tiers?id=${id}`, { method: 'DELETE', headers: auth });
    load();
  };

  const kindLabel = (k: string) =>
    k === 'membership'
      ? t('adminRecharge.kindMembership')
      : k === 'minutes'
        ? t('adminRecharge.kindMinutes')
        : t('adminRecharge.kindTopup');

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button className={BTN_PRIMARY} onClick={() => setEditing({ ...EMPTY_TIER })}>
          <Plus className="w-4 h-4" />
          {t('adminRecharge.newTier')}
        </button>
      </div>

      <div className={`${CARD} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-charcoal-400 border-b border-cream-200 dark:border-charcoal-700">
              <th className="px-3 py-2">{t('adminRecharge.colType')}</th>
              <th className="px-3 py-2">{t('adminRecharge.colName')}</th>
              <th className="px-3 py-2">{t('adminRecharge.colPrice')}</th>
              <th className="px-3 py-2">{t('adminRecharge.colGrant')}</th>
              <th className="px-3 py-2">{t('adminRecharge.colActive')}</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((tr) => (
              <tr key={tr.id} className="border-b border-cream-100 dark:border-charcoal-700/50">
                <td className="px-3 py-2">{kindLabel(tr.kind)}</td>
                <td className="px-3 py-2 font-medium text-charcoal-700 dark:text-cream-200">{tr.name}</td>
                <td className="px-3 py-2">{formatCurrencyCents(tr.priceCents)}</td>
                <td className="px-3 py-2 text-charcoal-500">
                  {tr.kind === 'membership' && `${tr.grantRole} · ${tr.durationDays}${t('adminRecharge.days')}`}
                  {tr.kind === 'minutes' && `+${tr.grantMinutes} ${t('adminRecharge.minutes')}`}
                  {tr.kind === 'topup' && formatCurrencyCents(tr.creditCents ?? tr.priceCents)}
                </td>
                <td className="px-3 py-2">
                  {tr.active ? (
                    <span className="text-green-600">●</span>
                  ) : (
                    <span className="text-charcoal-300">○</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    className="p-1 text-charcoal-400 hover:text-rust-500"
                    onClick={() => setEditing(prepareTierForAdminEdit(tr))}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button className="p-1 text-charcoal-400 hover:text-red-500" onClick={() => del(tr.id)}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
            {tiers.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-charcoal-400">
                  {t('adminRecharge.noTiers')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <TierForm
          editing={editing}
          setEditing={setEditing}
          onSave={save}
          error={error}
          kindLabel={kindLabel}
        />
      )}
    </div>
  );
}

function TierForm({
  editing,
  setEditing,
  onSave,
  error,
  kindLabel,
}: {
  editing: Partial<Tier>;
  setEditing: (t: Partial<Tier> | null) => void;
  onSave: () => void;
  error: string | null;
  kindLabel: (k: string) => string;
}) {
  const { t } = useI18n();
  const legacyAdminTier = Boolean(editing.id && isForbiddenAdminTier(editing));
  const set = <K extends keyof Tier>(k: K, v: Tier[K] | undefined) =>
    setEditing({ ...editing, [k]: v });
  const priceYuan = ((editing.priceCents ?? 0) / 100).toString();
  // 留空 = 「没填」，提交时该键整个缺席，后端回落成 = 价格。显示成 0 会诱导管理员把它当成
  // 「到账 0 元」原样存下去（P3-13）。
  const creditYuan = editing.creditCents == null ? '' : (editing.creditCents / 100).toString();

  return (
    <div className={`${CARD} p-4 space-y-3`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-charcoal-700 dark:text-cream-200">
          {editing.id ? t('adminRecharge.editTier') : t('adminRecharge.newTier')}
        </h3>
        <button className="p-1 text-charcoal-400" onClick={() => setEditing(null)}>
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>{t('adminRecharge.colType')}</label>
          <select
            className={INPUT}
            value={editing.kind}
            disabled={legacyAdminTier}
            onChange={(e) => set('kind', e.target.value as Tier['kind'])}
          >
            <option value="topup">{kindLabel('topup')}</option>
            <option value="minutes">{kindLabel('minutes')}</option>
            <option value="membership">{kindLabel('membership')}</option>
          </select>
        </div>
        <div>
          <label className={LABEL} htmlFor="tier-name">{t('adminRecharge.colName')}</label>
          <input
            id="tier-name"
            className={INPUT}
            value={editing.name ?? ''}
            disabled={legacyAdminTier}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="tier-price">{t('adminRecharge.priceYuan')}</label>
          <input
            id="tier-price"
            type="number"
            className={INPUT}
            value={priceYuan}
            disabled={legacyAdminTier}
            onChange={(e) => set('priceCents', Math.round(Number(e.target.value) * 100))}
          />
        </div>
        {editing.kind === 'membership' && (
          <>
            <div>
              <label className={LABEL}>{t('adminRecharge.grantRole')}</label>
              <select
                className={INPUT}
                value={editing.grantRole ?? 'PRO'}
                disabled={legacyAdminTier}
                onChange={(e) => set('grantRole', e.target.value)}
              >
                {legacyAdminTier && <option value="ADMIN">ADMIN</option>}
                {PURCHASABLE_MEMBERSHIP_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL}>{t('adminRecharge.durationDays')}</label>
              <input
                type="number"
                className={INPUT}
                value={editing.durationDays ?? 30}
                disabled={legacyAdminTier}
                onChange={(e) => set('durationDays', Math.floor(Number(e.target.value)))}
              />
            </div>
          </>
        )}
        {editing.kind === 'minutes' && (
          <div>
            <label className={LABEL}>{t('adminRecharge.grantMinutes')}</label>
            <input
              type="number"
              className={INPUT}
              value={editing.grantMinutes ?? 0}
              onChange={(e) => set('grantMinutes', Math.floor(Number(e.target.value)))}
            />
          </div>
        )}
        {editing.kind === 'topup' && (
          <div>
            <label className={LABEL}>{t('adminRecharge.creditYuan')}</label>
            <input
              type="number"
              className={INPUT}
              value={creditYuan}
              placeholder={priceYuan}
              onChange={(e) =>
                set(
                  'creditCents',
                  e.target.value === '' ? undefined : Math.round(Number(e.target.value) * 100)
                )
              }
            />
          </div>
        )}
        <div>
          <label className={LABEL}>{t('adminRecharge.sortOrder')}</label>
          <input
            type="number"
            className={INPUT}
            value={editing.sortOrder ?? 0}
            disabled={legacyAdminTier}
            onChange={(e) => set('sortOrder', Math.floor(Number(e.target.value)))}
          />
        </div>
        <label className="flex items-center gap-2 mt-6">
          <input
            type="checkbox"
            checked={legacyAdminTier ? false : (editing.active ?? true)}
            disabled={legacyAdminTier}
            onChange={(e) => set('active', e.target.checked)}
            className="accent-rust-500"
          />
          <span className="text-sm text-charcoal-700 dark:text-cream-200">{t('adminRecharge.colActive')}</span>
        </label>
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex gap-2">
        <button className={BTN_PRIMARY} onClick={onSave}>
          <Save className="w-4 h-4" />
          {t('common.save')}
        </button>
        <button className={BTN_GHOST} onClick={() => setEditing(null)}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 进账出账台账 + 手动调整
// ─────────────────────────────────────────────────────────────────────────────
function LedgerSection() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const [view, setView] = useState<'orders' | 'transactions'>('transactions');
  const [orders, setOrders] = useState<Order[]>([]);
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const load = useCallback(async () => {
    const url =
      view === 'orders'
        ? `/api/admin/recharge/orders?page=${page}`
        : `/api/admin/recharge/ledger?page=${page}`;
    const res = await fetch(url, { headers: auth });
    if (res.ok) {
      const data = await res.json();
      if (view === 'orders') setOrders(data.orders);
      else setTxs(data.transactions);
      setTotalPages(data.pagination.totalPages || 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, page, token]);

  useEffect(() => {
    load();
  }, [load]);

  const typeLabel = (ty: string) => t(`adminRecharge.txType_${ty}`) || ty;

  return (
    <div className="space-y-4">
      <AdjustForm onDone={load} />

      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {(['transactions', 'orders'] as const).map((v) => (
            <button
              key={v}
              onClick={() => {
                setView(v);
                setPage(1);
              }}
              className={`px-3 py-1.5 rounded-lg text-sm ${
                view === v ? 'bg-rust-50 text-rust-600' : 'text-charcoal-400 hover:text-charcoal-600'
              }`}
            >
              {v === 'orders' ? t('adminRecharge.viewOrders') : t('adminRecharge.viewTransactions')}
            </button>
          ))}
        </div>
        <button className={BTN_GHOST} onClick={load}>
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div className={`${CARD} overflow-x-auto`}>
        {view === 'transactions' ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-charcoal-400 border-b border-cream-200 dark:border-charcoal-700">
                <th className="px-3 py-2">{t('adminRecharge.colTime')}</th>
                <th className="px-3 py-2">{t('adminRecharge.colUser')}</th>
                <th className="px-3 py-2">{t('adminRecharge.colTxType')}</th>
                <th className="px-3 py-2">{t('adminRecharge.colAmount')}</th>
                <th className="px-3 py-2">{t('adminRecharge.colBalanceAfter')}</th>
                <th className="px-3 py-2">{t('adminRecharge.colNote')}</th>
              </tr>
            </thead>
            <tbody>
              {txs.map((tx) => (
                <tr key={tx.id} className="border-b border-cream-100 dark:border-charcoal-700/50">
                  <td className="px-3 py-2 text-charcoal-400 whitespace-nowrap">
                    {new Date(tx.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">{tx.userEmail ?? '—'}</td>
                  <td className="px-3 py-2">{typeLabel(tx.type)}</td>
                  <td
                    className={`px-3 py-2 font-medium ${tx.amountCents >= 0 ? 'text-green-600' : 'text-rust-600'}`}
                  >
                    {formatCurrencyCents(tx.amountCents)}
                    {tx.minutesDelta ? ` · ${tx.minutesDelta > 0 ? '+' : ''}${tx.minutesDelta}m` : ''}
                  </td>
                  <td className="px-3 py-2 text-charcoal-500">{formatCurrencyCents(tx.balanceAfterCents)}</td>
                  <td className="px-3 py-2 text-charcoal-400">{tx.note ?? '—'}</td>
                </tr>
              ))}
              {txs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-charcoal-400">
                    {t('adminRecharge.noRecords')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-charcoal-400 border-b border-cream-200 dark:border-charcoal-700">
                <th className="px-3 py-2">{t('adminRecharge.colTime')}</th>
                <th className="px-3 py-2">{t('adminRecharge.colUser')}</th>
                <th className="px-3 py-2">{t('adminRecharge.colProvider')}</th>
                <th className="px-3 py-2">{t('adminRecharge.colAmount')}</th>
                <th className="px-3 py-2">{t('adminRecharge.colStatus')}</th>
                <th className="px-3 py-2">{t('adminRecharge.colOrderNo')}</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-cream-100 dark:border-charcoal-700/50">
                  <td className="px-3 py-2 text-charcoal-400 whitespace-nowrap">
                    {new Date(o.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">{o.userEmail ?? '—'}</td>
                  <td className="px-3 py-2">{o.provider}</td>
                  <td className="px-3 py-2 font-medium">{formatCurrencyCents(o.amountCents)}</td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        o.status === 'paid'
                          ? 'text-green-600'
                          : o.status === 'pending'
                            ? 'text-amber-600'
                            : 'text-charcoal-400'
                      }
                    >
                      {t(`adminRecharge.orderStatus_${o.status}`) || o.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-charcoal-400 font-mono text-xs">{o.outTradeNo}</td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-charcoal-400">
                    {t('adminRecharge.noRecords')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center justify-center gap-3">
        <button className={BTN_GHOST} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-sm text-charcoal-500">
          {page} / {totalPages}
        </span>
        <button
          className={BTN_GHOST}
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function AdjustForm({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const [email, setEmail] = useState('');
  const [amountYuan, setAmountYuan] = useState('');
  const [minutes, setMinutes] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  // 调整没有幂等键：一次点击就是一笔真实台账。按钮必须自带 in-flight 闸（对照本文件里保存渠道
  // 配置的 disabled={saving}、删除档位的 confirm），否则手抖双击 = 加两次钱（P3-18）。
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (submitting) return;
    const amountCentsDelta = amountYuan ? Math.round(Number(amountYuan) * 100) : 0;
    const minutesDelta = minutes ? Math.floor(Number(minutes)) : 0;
    if (
      !confirm(
        t('adminRecharge.confirmAdjust', {
          email: email.trim(),
          amount: (amountCentsDelta / 100).toString(),
          minutes: minutesDelta.toString(),
        })
      )
    ) {
      return;
    }
    setSubmitting(true);
    setMsg(null);
    try {
      const res = await fetch('/api/admin/recharge/adjust', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          email: email.trim(),
          amountCentsDelta,
          minutesDelta,
          note: note.trim() || undefined,
        }),
      });
      if (res.ok) {
        setMsg(t('adminRecharge.adjustDone'));
        setAmountYuan('');
        setMinutes('');
        setNote('');
        onDone();
      } else {
        setMsg((await res.json()).error ?? t('common.saveFailed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={`${CARD} p-4 space-y-3`}>
      <h3 className="text-sm font-semibold text-charcoal-700 dark:text-cream-200">
        {t('adminRecharge.manualAdjust')}
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div>
          <label className={LABEL} htmlFor="adj-email">{t('adminRecharge.userEmail')}</label>
          <input id="adj-email" className={INPUT} value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className={LABEL} htmlFor="adj-amount">{t('adminRecharge.adjustAmountYuan')}</label>
          <input
            id="adj-amount"
            type="number"
            className={INPUT}
            value={amountYuan}
            onChange={(e) => setAmountYuan(e.target.value)}
            placeholder="0"
          />
        </div>
        <div>
          <label className={LABEL}>{t('adminRecharge.adjustMinutes')}</label>
          <input
            type="number"
            className={INPUT}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            placeholder="0"
          />
        </div>
        <div>
          <label className={LABEL}>{t('adminRecharge.colNote')}</label>
          <input className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button className={BTN_PRIMARY} onClick={submit} disabled={!email.trim() || submitting}>
          {submitting ? t('common.saving') : t('adminRecharge.applyAdjust')}
        </button>
        {msg && <span className="text-sm text-charcoal-500">{msg}</span>}
      </div>
    </div>
  );
}
