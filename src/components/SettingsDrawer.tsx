'use client';

import { useState, useEffect } from 'react';
import BottomSheet from '@/components/mobile/BottomSheet';
import { useIsMobile } from '@/hooks/useIsMobile';
import { normalizeMicrophoneDevices } from '@/lib/audio/audioCapture';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTranscriptStore } from '@/stores/transcriptStore';
import LanguageSelect from '@/components/LanguageSelect';
import { useI18n } from '@/lib/i18n';
import { X, Globe, Cpu, Sparkles, Sliders, Mic, AlertTriangle } from 'lucide-react';
import type { TranslationMode } from '@/types/transcript';
import { LocalTranslator } from '@/lib/translation/localTranslator';

export default function SettingsDrawer({
  isOpen,
  onClose,
  onSwitchMic,
  onSettingsApplied,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSwitchMic?: (deviceId: string) => void;
  onSettingsApplied?: () => void;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const settings = useSettingsStore();
  const currentMicDeviceId = useTranscriptStore((s) => s.currentMicDeviceId);
  const availableMics = useTranscriptStore((s) => s.availableMics);
  const setAvailableMics = useTranscriptStore((s) => s.setAvailableMics);
  const recordingState = useTranscriptStore((s) => s.recordingState);
  const isActive = recordingState === 'recording' || recordingState === 'paused';

  // Local draft state — only written to store on "Apply"
  const [draft, setDraft] = useState({
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    translationMode: settings.translationMode,
    domain: settings.domain,
    topic: settings.topic,
    terms: settings.terms,
  });
  const [termsInput, setTermsInput] = useState(settings.terms.join(', '));

  // Re-snapshot whenever the drawer opens
  useEffect(() => {
    if (isOpen) {
      setDraft({
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
        translationMode: settings.translationMode,
        domain: settings.domain,
        topic: settings.topic,
        terms: settings.terms,
      });
      setTermsInput(settings.terms.join(', '));
      // 刷新麦克风列表
      navigator.mediaDevices.enumerateDevices()
        .then((devices) => {
          const mics = normalizeMicrophoneDevices(devices, {
            fallbackDeviceId: currentMicDeviceId,
          });
          setAvailableMics(mics);
        })
        .catch(() => {
          setAvailableMics(
            currentMicDeviceId
              ? normalizeMicrophoneDevices([], {
                  fallbackDeviceId: currentMicDeviceId,
                })
              : []
          );
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMicDeviceId, isOpen]);

  const handleApply = () => {
    const sonioxConfigChanged =
      draft.sourceLang !== settings.sourceLang ||
      draft.targetLang !== settings.targetLang ||
      draft.translationMode !== settings.translationMode ||
      draft.domain !== settings.domain ||
      draft.topic !== settings.topic ||
      JSON.stringify(draft.terms) !== JSON.stringify(settings.terms);

    settings.setSourceLang(draft.sourceLang);
    settings.setTargetLang(draft.targetLang);
    settings.setTranslationMode(draft.translationMode);
    settings.setDomain(draft.domain);
    settings.setTopic(draft.topic);
    settings.setTerms(draft.terms);
    onClose();

    if (sonioxConfigChanged && isActive) {
      onSettingsApplied?.();
    }
  };

  if (!isOpen) return null;

  const content = (
    <>
      <div className="px-6 py-5 space-y-8">
        {/* Microphone */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Mic className="w-4 h-4 text-rust-500" />
            <h3 className="font-semibold text-charcoal-700 text-sm">
              {t('settingsDrawer.microphone')}
            </h3>
          </div>

          <div className="space-y-1">
            {availableMics.length === 0 ? (
              <p className="text-xs text-charcoal-400">{t('settingsDrawer.noMicrophones')}</p>
            ) : (
              availableMics.map((mic) => {
                const isSelected = mic.deviceId === currentMicDeviceId;
                return (
                  <button
                    key={mic.deviceId}
                    onClick={() => onSwitchMic?.(mic.deviceId)}
                    disabled={!isActive}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-xs transition-colors flex items-center gap-2
                      ${isSelected
                        ? 'bg-rust-50 text-rust-700 border border-rust-200'
                        : 'text-charcoal-600 hover:bg-cream-50 border border-transparent'
                      }
                      ${!isActive ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <Mic className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate">{mic.label || `Mic ${mic.deviceId.slice(0, 8)}`}</span>
                    {isSelected && (
                      <span className="ml-auto text-[9px] font-semibold bg-rust-100 text-rust-600 px-1.5 py-0.5 rounded-full">
                        {t('settingsDrawer.inUse')}
                      </span>
                    )}
                  </button>
                );
              })
            )}
            {!isActive && (
              <p className="text-[11px] text-charcoal-400 mt-1">
                {t('settingsDrawer.startToSwitchMic')}
              </p>
            )}
          </div>
        </section>

        {/* Language Settings */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Globe className="w-4 h-4 text-rust-500" />
            <h3 className="font-semibold text-charcoal-700 text-sm">
              {t('settingsDrawer.languageSelection')}
            </h3>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-charcoal-500 uppercase tracking-wider">
                {t('settingsDrawer.sourceLanguage')}
              </label>
              <LanguageSelect
                value={draft.sourceLang}
                onChange={(code) => setDraft((d) => ({ ...d, sourceLang: code }))}
                displayMode="label"
                className="mt-1"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-charcoal-500 uppercase tracking-wider">
                {t('settingsDrawer.translationLanguage')}
              </label>
              <LanguageSelect
                value={draft.targetLang}
                onChange={(code) => setDraft((d) => ({ ...d, targetLang: code }))}
                allowNone
                noneLabel={t('settingsDrawer.noneTranscriptionOnly')}
                excludeCodes={[draft.sourceLang]}
                displayMode="label"
                className="mt-1"
              />
            </div>
          </div>
        </section>

        {/* Processing Method */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Cpu className="w-4 h-4 text-rust-500" />
            <h3 className="font-semibold text-charcoal-700 text-sm">
              {t('settingsDrawer.processingMethod')}
            </h3>
          </div>

          <div className="flex gap-2">
            {(['soniox', 'local', 'both'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setDraft((d) => ({ ...d, translationMode: m as TranslationMode }))}
                className={`flex-1 py-2.5 px-3 rounded-lg text-xs font-semibold uppercase tracking-wide
                           border transition-colors ${
                             draft.translationMode === m
                               ? 'bg-rust-500 text-white border-rust-500'
                               : 'bg-cream-50 text-charcoal-500 border-cream-300 hover:border-rust-300'
                           }`}
              >
                {m === 'soniox'
                  ? t('translationPanel.cloud')
                  : m === 'local'
                    ? t('settingsDrawer.localPrivate')
                    : t('settingsDrawer.both')}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-charcoal-400 mt-2">
            {draft.translationMode === 'local'
              ? t('settingsDrawer.localDesc')
              : draft.translationMode === 'both'
                ? t('settingsDrawer.bothDesc')
                : t('settingsDrawer.cloudDesc')}
          </p>
          {(draft.translationMode === 'local' || draft.translationMode === 'both') &&
            draft.targetLang &&
            !LocalTranslator.isSupported(draft.sourceLang, draft.targetLang) && (
              <div className="flex items-start gap-1.5 mt-2 p-2 rounded-lg bg-amber-50 border border-amber-200">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-[11px] text-amber-700">
                  {t('settingsDrawer.localUnsupportedPair')}
                </p>
              </div>
            )}
        </section>

        {/* Domain Context */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="w-4 h-4 text-rust-500" />
            <h3 className="font-semibold text-charcoal-700 text-sm">
              {t('settingsDrawer.domainContext')}
            </h3>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-charcoal-500 uppercase tracking-wider">
                {t('settingsDrawer.domain')}
              </label>
              <input
                type="text"
                value={draft.domain}
                onChange={(e) => setDraft((d) => ({ ...d, domain: e.target.value }))}
                placeholder={t('settingsDrawer.domainPlaceholder')}
                className="input-field mt-1"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-charcoal-500 uppercase tracking-wider">
                {t('settingsDrawer.topic')}
              </label>
              <input
                type="text"
                value={draft.topic}
                onChange={(e) => setDraft((d) => ({ ...d, topic: e.target.value }))}
                placeholder={t('settingsDrawer.topicPlaceholder')}
                className="input-field mt-1"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-charcoal-500 uppercase tracking-wider">
                {t('settingsDrawer.customTerms')}
              </label>
              <textarea
                value={termsInput}
                onChange={(e) => {
                  setTermsInput(e.target.value);
                  setDraft((d) => ({
                    ...d,
                    terms: e.target.value
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  }));
                }}
                placeholder={t('settingsDrawer.customTermsPlaceholder')}
                className="input-field mt-1 h-20 resize-none"
                rows={3}
              />
            </div>
          </div>
        </section>
      </div>

      <div className={`${isMobile ? 'sticky bottom-0' : 'sticky bottom-0'} px-6 py-4 bg-white border-t border-cream-200 flex justify-end gap-3 safe-bottom`}>
        <button onClick={onClose} className="btn-secondary text-sm">
          {t('common.discard')}
        </button>
        <button onClick={handleApply} className="btn-primary text-sm">
          {t('settingsDrawer.applyConfiguration')}
        </button>
      </div>
    </>
  );

  if (isMobile) {
    return (
      <BottomSheet open={isOpen} onClose={onClose} title={t('settingsDrawer.systemSettings')}>
        {content}
      </BottomSheet>
    );
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 animate-backdrop-enter"
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className="fixed right-0 top-0 h-full w-[420px] max-w-[90vw] bg-white
                   shadow-2xl z-50 overflow-y-auto animate-slide-in-right"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-cream-200 sticky top-0 bg-white z-10">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-rust-500" />
            <h2 className="font-serif font-bold text-charcoal-800">
              {t('settingsDrawer.systemSettings')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg
                       hover:bg-cream-100 text-charcoal-400 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {content}
      </div>
    </>
  );
}
