'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAuth } from '@/hooks/useAuth';
import { SONIOX_REGION_OPTIONS } from '@/types/transcript';
import LanguageSelect from '@/components/LanguageSelect';
import ModalPortal from '@/components/ModalPortal';
import { useExitAnimation } from '@/hooks/useExitAnimation';
import { useI18n } from '@/lib/i18n';
import { UI_LOCALE_OPTIONS, type Locale } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';
import { Settings, Globe, Cpu, Mic, Lock, Tags, Scissors, Languages, X } from 'lucide-react';
import type { ChatModelOption, ChatModelsResponse } from '@/types/llm';

function clampNumber(value: string, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parseTerms(value: string) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export default function UserSettingsModal() {
  const open = useSettingsStore((s) => s.userSettingsOpen);
  const setOpen = useSettingsStore((s) => s.setUserSettingsOpen);
  const { mounted, leaving } = useExitAnimation(open);
  const settings = useSettingsStore();
  const { user, token } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwMsg, setPwMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [pwLoading, setPwLoading] = useState(false);

  const [termsInput, setTermsInput] = useState(settings.terms.join(', '));
  const [providerOptions, setProviderOptions] = useState<ChatModelOption[]>([]);
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState(false);

  useEffect(() => {
    setTermsInput(settings.terms.join(', '));
  }, [settings.terms]);

  useEffect(() => {
    if (!token || !open) {
      return;
    }

    let cancelled = false;
    setProviderLoading(true);
    setProviderError(false);

    fetch('/api/llm/models', {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Provider API returned ${res.status}`);
        }
        return res.json() as Promise<ChatModelsResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setProviderOptions(data.models);
      })
      .catch(() => {
        if (cancelled) return;
        setProviderError(true);
      })
      .finally(() => {
        if (!cancelled) setProviderLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, open]);

  // 打开时重置密码字段
  useEffect(() => {
    if (open) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPwMsg(null);
    }
  }, [open]);

  const { locale, setLocale, t } = useI18n();

  const selectedProviderValue = settings.llmProvider || '__default__';
  const selectedProviderMeta = useMemo(
    () => providerOptions.find((provider) => provider.name === settings.llmProvider),
    [providerOptions, settings.llmProvider]
  );

  const handleTermsBlur = () => {
    settings.setTerms(parseTerms(termsInput));
  };

  const handleChangePassword = async () => {
    setPwMsg(null);
    if (!currentPassword || !newPassword || !confirmPassword) {
      const msg = t('auth.fillAllFields');
      setPwMsg({ type: 'error', text: msg });
      toast.error(msg);
      return;
    }
    if (newPassword.length < 8) {
      const msg = t('auth.passwordTooShort');
      setPwMsg({ type: 'error', text: msg });
      toast.error(msg);
      return;
    }
    if (newPassword !== confirmPassword) {
      const msg = t('auth.passwordMismatch');
      setPwMsg({ type: 'error', text: msg });
      toast.error(msg);
      return;
    }
    setPwLoading(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        credentials: 'include',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error || t('auth.changeFailed');
        setPwMsg({ type: 'error', text: msg });
        toast.error(t('auth.changeFailed'), data.error);
      } else {
        const msg = t('auth.passwordChanged');
        setPwMsg({ type: 'success', text: msg });
        toast.success(msg);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      }
    } catch {
      const msg = t('auth.networkError');
      setPwMsg({ type: 'error', text: msg });
      toast.error(t('auth.changeFailed'), t('common.networkError'));
    } finally {
      setPwLoading(false);
    }
  };

  if (!mounted) return null;

  return (
    <ModalPortal>
    <div className="fixed inset-0 z-[1100] flex items-center justify-center">
      {/* 背景遮罩 */}
      <div
        className={`absolute inset-0 bg-black/30 backdrop-blur-sm ${leaving ? 'animate-backdrop-leave' : 'animate-backdrop-enter'}`}
        onClick={() => setOpen(false)}
      />

      {/* 弹窗主体 */}
      <div className={`relative bg-cream-50 rounded-2xl shadow-2xl border border-cream-200 w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col mx-4 ${leaving ? 'animate-modal-leave' : 'animate-modal-enter'}`}>
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-cream-200 bg-white flex-shrink-0">
          <h2 className="font-serif text-lg font-bold text-charcoal-800">{t('settings.title')}</h2>
          <button
            onClick={() => setOpen(false)}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-charcoal-400 hover:bg-cream-100 hover:text-charcoal-600 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 可滚动内容区域 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* 账户 */}
          <section className="bg-white rounded-xl border border-cream-200 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-charcoal-700 mb-4">
              <Settings className="w-4 h-4" />
              {t('settings.account')}
            </h3>
            {user && (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-charcoal-400">{t('settings.name')}</span>
                  <span className="text-charcoal-700">{user.displayName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-charcoal-400">{t('settings.email')}</span>
                  <span className="text-charcoal-700">{user.email}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-charcoal-400">{t('settings.plan')}</span>
                  <span className="text-charcoal-700">{user.role}</span>
                </div>
              </div>
            )}
          </section>

          {/* 界面语言 */}
          <section className="bg-white rounded-xl border border-cream-200 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-charcoal-700 mb-4">
              <Languages className="w-4 h-4" />
              {t('settings.interfaceLanguage')}
            </h3>
            <div>
              <select
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
                className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm"
              >
                {UI_LOCALE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-charcoal-400">
                {t('settings.interfaceLanguageDesc')}
              </p>
            </div>
          </section>

          {/* 修改密码 */}
          <section className="bg-white rounded-xl border border-cream-200 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-charcoal-700 mb-4">
              <Lock className="w-4 h-4" />
              {t('auth.changePassword')}
            </h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-charcoal-400 mb-1">{t('auth.currentPassword')}</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm"
                  placeholder={t('settings.currentPasswordPlaceholder')}
                  autoComplete="current-password"
                />
              </div>
              <div>
                <label className="block text-xs text-charcoal-400 mb-1">{t('auth.newPassword')}</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm"
                  placeholder={t('settings.newPasswordPlaceholder')}
                  autoComplete="new-password"
                />
              </div>
              <div>
                <label className="block text-xs text-charcoal-400 mb-1">{t('auth.confirmPassword')}</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm"
                  placeholder={t('settings.confirmPasswordPlaceholder')}
                  autoComplete="new-password"
                />
              </div>
              {pwMsg && (
                <p className={`text-xs ${pwMsg.type === 'error' ? 'text-red-500' : 'text-green-600'}`}>
                  {pwMsg.text}
                </p>
              )}
              <button
                onClick={handleChangePassword}
                disabled={pwLoading}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-rust-500 text-white hover:bg-rust-600 transition-colors disabled:opacity-50"
              >
                {pwLoading ? t('common.saving') : t('auth.updatePassword')}
              </button>
            </div>
          </section>

          {/* 语言 */}
          <section className="bg-white rounded-xl border border-cream-200 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-charcoal-700 mb-4">
              <Globe className="w-4 h-4" />
              {t('settings.language')}
            </h3>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="block text-xs text-charcoal-400 mb-1">{t('settings.sourceLang')}</label>
                <LanguageSelect
                  value={settings.sourceLang}
                  onChange={settings.setSourceLang}
                  displayMode="label"
                />
              </div>
              <div>
                <label className="block text-xs text-charcoal-400 mb-1">{t('settings.targetLang')}</label>
                <LanguageSelect
                  value={settings.targetLang}
                  onChange={settings.setTargetLang}
                  allowNone
                  noneLabel={t('settings.noTranslation')}
                  excludeCodes={[settings.sourceLang]}
                  displayMode="label"
                />
              </div>
            </div>
          </section>

          {/* LLM & 摘要 */}
          <section className="bg-white rounded-xl border border-cream-200 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-charcoal-700 mb-4">
              <Cpu className="w-4 h-4" />
              {t('settings.llmSummary')}
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-charcoal-400 mb-1">{t('settings.summaryProvider')}</label>
                <select
                  value={selectedProviderValue}
                  onChange={(e) =>
                    settings.setLlmProvider(
                      e.target.value === '__default__' ? '' : e.target.value
                    )
                  }
                  className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm"
                  disabled={providerLoading}
                >
                  <option value="__default__">{t('settings.usePlatformDefault')}</option>
                  {providerOptions.map((provider) => (
                    <option key={provider.name} value={provider.name}>
                      {provider.displayName}
                    </option>
                  ))}
                  {settings.llmProvider &&
                    !providerOptions.some((provider) => provider.name === settings.llmProvider) && (
                      <option value={settings.llmProvider}>{settings.llmProvider}</option>
                    )}
                </select>
                <p className="mt-1 text-[11px] text-charcoal-400">
                  {t('settings.summaryProviderDesc')}{' '}
                  {selectedProviderMeta?.supportsThinking
                    ? t('settings.supportsDeepReasoning')
                    : t('settings.standardReasoning')}
                </p>
                {providerError && (
                  <p className="mt-1 text-[11px] text-red-500">{t('settings.providerLoadError')}</p>
                )}
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div>
                  <label className="block text-xs text-charcoal-400 mb-1">{t('settings.summaryLanguage')}</label>
                  <LanguageSelect
                    value={settings.summaryLanguage}
                    onChange={settings.setSummaryLanguage}
                    displayMode="label"
                  />
                </div>

                <div>
                  <label className="block text-xs text-charcoal-400 mb-1">{t('settings.triggerSentences')}</label>
                  <input
                    type="number"
                    min={4}
                    max={40}
                    value={settings.summaryTriggerSentences}
                    onChange={(e) =>
                      settings.setSummaryTriggerSentences(
                        clampNumber(e.target.value, settings.summaryTriggerSentences, 4, 40)
                      )
                    }
                    className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs text-charcoal-400 mb-1">{t('settings.triggerMinutes')}</label>
                  <input
                    type="number"
                    min={1}
                    max={15}
                    value={settings.summaryTriggerMinutes}
                    onChange={(e) =>
                      settings.setSummaryTriggerMinutes(
                        clampNumber(e.target.value, settings.summaryTriggerMinutes, 1, 15)
                      )
                    }
                    className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm"
                  />
                </div>
              </div>

              <div className="rounded-lg border border-cream-200 bg-cream-50 px-3 py-2 text-[11px] text-charcoal-500">
                {t('settings.summaryTriggerDesc')}
              </div>
            </div>
          </section>

          {/* ASR 默认设置 */}
          <section className="bg-white rounded-xl border border-cream-200 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-charcoal-700 mb-4">
              <Mic className="w-4 h-4" />
              {t('settings.asrDefaults')}
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-charcoal-400 mb-1">{t('settings.sonioxRegion')}</label>
                <select
                  value={settings.sonioxRegionPreference}
                  onChange={(e) =>
                    settings.setSonioxRegionPreference(
                      e.target.value as typeof settings.sonioxRegionPreference
                    )
                  }
                  className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm"
                >
                  {SONIOX_REGION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-charcoal-400">
                  {t('settings.autoRegionDesc')}
                </p>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="block text-xs text-charcoal-400 mb-1">{t('settings.domain')}</label>
                  <input
                    type="text"
                    value={settings.domain}
                    onChange={(e) => settings.setDomain(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-charcoal-400 mb-1">{t('settings.topic')}</label>
                  <input
                    type="text"
                    value={settings.topic}
                    onChange={(e) => settings.setTopic(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="flex items-center gap-2 text-xs text-charcoal-400 mb-1">
                  <Tags className="w-3.5 h-3.5" />
                  {t('settings.contextTerms')}
                </label>
                <textarea
                  value={termsInput}
                  onChange={(e) => setTermsInput(e.target.value)}
                  onBlur={handleTermsBlur}
                  rows={4}
                  className="w-full px-3 py-2 rounded-lg border border-cream-300 text-sm resize-y"
                  placeholder={t('settings.contextTermsPlaceholder')}
                />
                <p className="mt-1 text-[11px] text-charcoal-400">
                  {t('settings.contextTermsDesc')}
                </p>
              </div>
            </div>
          </section>

          {/* 段落截断 */}
          <section className="bg-white rounded-xl border border-cream-200 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-charcoal-700 mb-4">
              <Scissors className="w-4 h-4" />
              {t('settings.transcriptSegment')}
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-charcoal-400 mb-1">
                  {t('settings.segmentSplitThreshold')}
                </label>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min={0}
                    max={50}
                    step={5}
                    value={Math.round(settings.segmentSplitRatio * 100)}
                    onChange={(e) =>
                      settings.setSegmentSplitRatio(Number(e.target.value) / 100)
                    }
                    className="flex-1 accent-rust-500"
                  />
                  <span className="text-sm font-mono text-charcoal-700 w-16 text-right">
                    {settings.segmentSplitRatio <= 0
                      ? t('settings.off')
                      : `${Math.round(settings.segmentSplitRatio * 100)}%`}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-charcoal-400">
                  {t('settings.segmentSplitDesc')}
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
