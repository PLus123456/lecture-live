'use client';

// 用户个人设置页的「邮件通知偏好」面板：各类通知邮件（订阅/到期/额度/产品更新/促销）
// 用户可自行勾选收不收。事务类（验证/重置/安全提醒）不在此列，恒发。
// 站点关闭营销总开关时，营销类分类显示为禁用并注明「管理员已全局关闭」。

import { useCallback, useEffect, useState } from 'react';
import { Mail, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';

interface CategoryMeta {
  key: string;
  marketing: boolean;
}

export default function EmailPreferencesSection() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [categories, setCategories] = useState<CategoryMeta[]>([]);
  const [marketingEnabled, setMarketingEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch('/api/user/email-preferences', {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setPrefs(data.preferences ?? {});
        setCategories(Array.isArray(data.categories) ? data.categories : []);
        setMarketingEnabled(data.marketingEnabled !== false);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const toggle = useCallback(
    async (key: string, next: boolean) => {
      if (!token) return;
      const prev = prefs[key];
      setPrefs((p) => ({ ...p, [key]: next })); // 乐观更新
      setSavingKey(key);
      try {
        const res = await fetch('/api/user/email-preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          credentials: 'include',
          body: JSON.stringify({ preferences: { [key]: next } }),
        });
        if (!res.ok) throw new Error('save failed');
        const data = await res.json();
        if (data?.preferences) setPrefs(data.preferences);
      } catch {
        setPrefs((p) => ({ ...p, [key]: prev })); // 回滚
        toast.error(t('common.networkError'));
      } finally {
        setSavingKey(null);
      }
    },
    [token, prefs, t]
  );

  return (
    <section className="bg-white rounded-xl border border-cream-200 p-5 animate-fade-in-up">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-charcoal-700 mb-1">
        <Mail className="w-4 h-4" />
        {t('emailPrefs.title')}
      </h2>
      <p className="text-[11px] text-charcoal-400 mb-4">{t('emailPrefs.desc')}</p>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-charcoal-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('common.loading')}
        </div>
      ) : (
        <div className="space-y-3">
          {categories.map((cat) => {
            const disabled = cat.marketing && !marketingEnabled;
            const checked = disabled ? false : !!prefs[cat.key];
            return (
              <div key={cat.key} className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm text-charcoal-700">
                    {t(`emailPrefs.category.${cat.key}`)}
                  </div>
                  <div className="text-[11px] text-charcoal-400">
                    {disabled
                      ? t('emailPrefs.marketingDisabledByAdmin')
                      : t(`emailPrefs.categoryDesc.${cat.key}`)}
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={checked}
                  disabled={disabled || savingKey === cat.key}
                  onClick={() => toggle(cat.key, !checked)}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors
                    ${checked ? 'bg-rust-500' : 'bg-cream-300 dark:bg-charcoal-600'}
                    ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                      ${checked ? 'translate-x-4' : 'translate-x-0.5'}`}
                  />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
