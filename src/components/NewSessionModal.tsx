'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMicrophoneMonitor } from '@/hooks/useMicrophoneMonitor';
import { useAuth } from '@/hooks/useAuth';
import { resolveSessionTerms } from '@/lib/keywords/sessionTerms';
import { useI18n } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  SONIOX_REGION_OPTIONS,
  toSessionAudioSource,
} from '@/types/transcript';
import LanguageSelect from '@/components/LanguageSelect';
import {
  Mic,
  Monitor,
  ArrowRight,
  Loader2,
  X,
  FolderOpen,
  Archive,
  Plus,
  Check,
} from 'lucide-react';

interface FolderItem {
  id: string;
  name: string;
  parentId: string | null;
}

interface NewSessionModalProps {
  onClose: () => void;
  defaultFolderId?: string;
}

export default function NewSessionModal({ onClose, defaultFolderId }: NewSessionModalProps) {
  const router = useRouter();
  const { token } = useAuth();
  const { t, locale } = useI18n();

  const audioSource = useSettingsStore((s) => s.audioSource);
  const preferredMicDeviceId = useSettingsStore((s) => s.preferredMicDeviceId);
  const sourceLang = useSettingsStore((s) => s.sourceLang);
  const targetLang = useSettingsStore((s) => s.targetLang);
  const terms = useSettingsStore((s) => s.terms);
  const llmProvider = useSettingsStore((s) => s.llmProvider);
  const sonioxRegionPreference = useSettingsStore((s) => s.sonioxRegionPreference);
  const setAudioSource = useSettingsStore((s) => s.setAudioSource);
  const setPreferredMicDeviceId = useSettingsStore((s) => s.setPreferredMicDeviceId);
  const setSourceLang = useSettingsStore((s) => s.setSourceLang);
  const setTargetLang = useSettingsStore((s) => s.setTargetLang);
  const setSonioxRegionPreference = useSettingsStore((s) => s.setSonioxRegionPreference);
  const setPendingAutoStart = useSettingsStore((s) => s.setPendingAutoStart);
  const setPendingSessionTerms = useSettingsStore((s) => s.setPendingSessionTerms);
  const setPendingSystemStream = useSettingsStore((s) => s.setPendingSystemStream);

  const [isStarting, setIsStarting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Defer mic activation so modal UI renders first
  const [micReady, setMicReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMicReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Folders
  const [folderId, setFolderId] = useState<string>(defaultFolderId ?? '');
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderCreating, setFolderCreating] = useState(false);

  // System audio
  const [systemAudioStatus, setSystemAudioStatus] = useState<
    'idle' | 'requesting' | 'granted' | 'error'
  >('idle');
  const [systemAudioError, setSystemAudioError] = useState<string | null>(null);
  const systemStreamRef = useRef<MediaStream | null>(null);

  const {
    activeDeviceId,
    availableMics,
    level,
    error: microphoneError,
    placeholderLabel,
    permissionState,
    requestAccess: requestMicrophoneAccess,
  } = useMicrophoneMonitor({
    enabled: micReady && audioSource === 'mic',
    preferredDeviceId: preferredMicDeviceId,
  });

  // Mic device fallback
  useEffect(() => {
    if (!micReady || audioSource !== 'mic') return;
    const still = preferredMicDeviceId && availableMics.some((m) => m.deviceId === preferredMicDeviceId);
    if (still) return;
    const fb = activeDeviceId || availableMics[0]?.deviceId || null;
    if (fb !== preferredMicDeviceId) setPreferredMicDeviceId(fb);
  }, [micReady, activeDeviceId, availableMics, audioSource, preferredMicDeviceId, setPreferredMicDeviceId]);

  // Fetch folders
  useEffect(() => {
    if (!token) return;
    fetch('/api/folders', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setFolders(data); })
      .catch(() => {});
  }, [token]);

  // System audio cleanup
  useEffect(() => {
    if (audioSource !== 'system' && systemStreamRef.current) {
      systemStreamRef.current.getTracks().forEach((t) => t.stop());
      systemStreamRef.current = null;
      setSystemAudioStatus('idle');
      setSystemAudioError(null);
    }
  }, [audioSource]);

  useEffect(() => () => { systemStreamRef.current?.getTracks().forEach((t) => t.stop()); }, []);

  // Request system audio
  const requestSystemAudio = useCallback(async () => {
    if (systemStreamRef.current) {
      systemStreamRef.current.getTracks().forEach((t) => t.stop());
      systemStreamRef.current = null;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setSystemAudioStatus('error');
      setSystemAudioError(t('session.newSession.browserDoesNotSupportSystemAudio'));
      return;
    }
    setSystemAudioStatus('requesting');
    setSystemAudioError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        setSystemAudioStatus('error');
        setSystemAudioError(t('session.newSession.noSystemAudioCaptured'));
        return;
      }
      stream.getVideoTracks().forEach((t) => t.stop());
      systemStreamRef.current = new MediaStream(audioTracks);
      setSystemAudioStatus('granted');
      audioTracks[0]?.addEventListener('ended', () => {
        setSystemAudioStatus('idle');
        systemStreamRef.current = null;
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setSystemAudioStatus('idle');
        setAudioSource('mic');
        return;
      }
      setSystemAudioStatus('error');
      setSystemAudioError(
        err instanceof Error ? err.message : t('session.newSession.systemAudioRequestFailed')
      );
    }
  }, [setAudioSource, t]);

  const handleSelectSystemAudio = useCallback(() => {
    setAudioSource('system');
    void requestSystemAudio();
  }, [setAudioSource, requestSystemAudio]);

  // Create folder inline
  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name || !token) return;
    setFolderCreating(true);
    try {
      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        const folder = await res.json();
        setFolders((prev) => [folder, ...prev]);
        setFolderId(folder.id);
        setNewFolderName('');
        setIsCreatingFolder(false);
      }
    } catch { /* silent */ }
    setFolderCreating(false);
  }, [newFolderName, token]);

  // Start session
  const handleStart = useCallback(async () => {
    if (isStarting) return;
    if (!token) { router.push('/login'); return; }
    setIsStarting(true);
    setErrorMsg(null);
    try {
      const now = new Date();
      const autoTitle = now.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: t('session.newSession.autoTitle', { date: autoTitle }),
          sourceLang,
          targetLang,
          llmProvider: llmProvider || undefined,
          audioSource: toSessionAudioSource(audioSource),
          sonioxRegion: sonioxRegionPreference,
          folderId: folderId || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(
          data.error ||
            t('session.newSession.failedToCreateSession', { status: res.status })
        );
        setIsStarting(false);
        return;
      }
      const session = await res.json();
      const sessionTerms = await resolveSessionTerms({
        token,
        folderId: folderId || null,
        sessionKeywords: terms,
      });
      setPendingSessionTerms(session.id, sessionTerms);
      if (audioSource === 'mic') {
        const fb = preferredMicDeviceId || activeDeviceId || availableMics[0]?.deviceId || null;
        if (fb) setPreferredMicDeviceId(fb);
      }
      // Hand off system audio stream to session page so it doesn't need re-auth
      if (audioSource === 'system' && systemStreamRef.current) {
        setPendingSystemStream(systemStreamRef.current);
        systemStreamRef.current = null; // prevent cleanup on unmount
      }
      setIsStarting(false);
      setPendingAutoStart(true);
      router.push(`/session/${session.id}`);
    } catch {
      setErrorMsg(t('session.newSession.networkError'));
      setIsStarting(false);
    }
  }, [
    isStarting, token, router, sourceLang, targetLang, folderId, audioSource,
    preferredMicDeviceId, activeDeviceId, availableMics, setPendingAutoStart,
    setPendingSessionTerms, setPendingSystemStream, setPreferredMicDeviceId,
    sonioxRegionPreference, terms, llmProvider, locale, t,
  ]);

  // Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isStarting) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isStarting, onClose]);

  // Audio-reactive values for the top mic icon
  const isAudioActive = audioSource === 'mic' && permissionState === 'granted';
  const normLevel = isAudioActive ? Math.min(1, level / 0.15) : 0;
  const ringScale = 1 + normLevel * 0.6;
  const ringOpacity = 0.08 + normLevel * 0.27;
  const outerScale = 1 + normLevel * 0.9;
  const outerOpacity = 0.04 + normLevel * 0.18;
  const iconScale = 1 + normLevel * 0.08;

  // Current mic label
  const currentMic = availableMics.find((m) => m.deviceId === (preferredMicDeviceId ?? activeDeviceId));
  const micLabel = currentMic?.label || (availableMics[0]?.label) || '';
  const shortMicLabel = micLabel.length > 28 ? micLabel.slice(0, 26) + '...' : micLabel;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop with blur */}
      <div
        className="absolute inset-0 bg-charcoal-900/30 backdrop-blur-xl animate-backdrop-enter"
        onClick={() => { if (!isStarting) onClose(); }}
      />

      {/* Modal card */}
      <div
        className="relative w-[400px] bg-white/95 backdrop-blur-sm rounded-2xl shadow-2xl
                    border border-cream-200/60 overflow-hidden
                    animate-modal-enter"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          disabled={isStarting}
          className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center
                     rounded-full text-charcoal-400 hover:text-charcoal-600 hover:bg-cream-100
                     transition-colors disabled:opacity-40 z-10"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Content */}
        <div className="px-6 pt-6 pb-5">
          {/* Audio-reactive mic icon */}
          <div className="flex flex-col items-center mb-5">
            <div className="relative w-20 h-20 flex items-center justify-center mb-2">
              {/* Outer ring - audio reactive */}
              <div
                className="absolute inset-0 rounded-full bg-rust-500 transition-all duration-75 ease-out"
                style={{
                  transform: `scale(${outerScale})`,
                  opacity: outerOpacity,
                }}
              />
              {/* Inner ring - audio reactive */}
              <div
                className="absolute inset-2 rounded-full bg-rust-500 transition-all duration-75 ease-out"
                style={{
                  transform: `scale(${ringScale})`,
                  opacity: ringOpacity,
                }}
              />
              {/* Static subtle ring when no audio */}
              {!isAudioActive && (
                <>
                  <div className="absolute inset-0 rounded-full bg-rust-500/[0.08] animate-ping" style={{ animationDuration: '2.5s' }} />
                  <div className="absolute inset-2 rounded-full bg-rust-500/10 animate-ping" style={{ animationDuration: '2.5s', animationDelay: '0.4s' }} />
                </>
              )}
              {/* Center icon */}
              <div
                className="relative w-12 h-12 rounded-full bg-rust-500 flex items-center justify-center shadow-lg shadow-rust-500/30
                           transition-transform duration-75 ease-out"
                style={{ transform: `scale(${iconScale})` }}
              >
                <Mic className="w-5 h-5 text-white" />
              </div>
            </div>
            <span className="text-sm font-medium text-charcoal-700">{t('session.newSession.title')}</span>
            {audioSource === 'mic' && permissionState === 'granted' && !microphoneError && (
              <span className="text-[10px] text-emerald-600 mt-0.5">
                {level >= 0.05 ? t('session.newSession.listening') : t('session.newSession.micReady')}
              </span>
            )}
            {audioSource === 'mic' && microphoneError && (
              <span className="text-[10px] text-red-500 mt-0.5">{microphoneError}</span>
            )}
          </div>

          {/* Language pair */}
          <div className="flex items-center gap-2 mb-3">
            <LanguageSelect
              value={sourceLang}
              onChange={setSourceLang}
              className="flex-1"
            />

            <ArrowRight className="w-4 h-4 text-charcoal-300 shrink-0" />

            <LanguageSelect
              value={targetLang}
              onChange={setTargetLang}
              allowNone
              noneLabel={t('session.newSession.targetNone')}
              excludeCodes={[sourceLang]}
              className="flex-1"
            />
          </div>

          <div className="mb-3">
            <div className="text-[10px] font-semibold text-charcoal-400 uppercase tracking-wider mb-1.5">
              {t('session.newSession.sonioxRegion')}
            </div>
            <select
              value={sonioxRegionPreference}
              onChange={(e) => setSonioxRegionPreference(e.target.value as typeof sonioxRegionPreference)}
              className="w-full px-3 py-2 rounded-lg border border-cream-300 bg-white
                         text-sm text-charcoal-700 focus:outline-none focus:border-rust-300
                         focus:ring-1 focus:ring-rust-200"
            >
              {SONIOX_REGION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/* Audio source: mic selector inline, system audio button */}
          <div className="flex gap-2 mb-3">
            {/* Mic: directly a device selector styled as a button */}
            <div className={`flex-1 relative rounded-lg border text-xs font-medium
                            transition-all duration-150 ${
                              audioSource === 'mic'
                                ? 'border-rust-400 bg-rust-50 text-rust-700 shadow-sm shadow-rust-500/10'
                                : 'border-cream-300 bg-white text-charcoal-500 hover:border-cream-400'
                            }`}
            >
              <div className="flex items-center gap-1.5 px-3 py-2.5 pointer-events-none">
                <Mic className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">
                  {audioSource === 'mic' && shortMicLabel
                    ? shortMicLabel
                    : t('session.newSession.microphone')}
                </span>
              </div>
              <select
                value={audioSource === 'mic' ? (preferredMicDeviceId ?? activeDeviceId ?? '') : '__select_mic__'}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '__select_mic__') {
                    setAudioSource('mic');
                    void requestMicrophoneAccess();
                    return;
                  }
                  setAudioSource('mic');
                  setPreferredMicDeviceId(val || null);
                  void requestMicrophoneAccess();
                }}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              >
                {audioSource !== 'mic' && (
                  <option value="__select_mic__">{t('session.newSession.switchToMicrophone')}</option>
                )}
                {availableMics.length === 0 && (
                  <option value="">{placeholderLabel}</option>
                )}
                {availableMics.map((mic) => (
                  <option key={mic.deviceId} value={mic.deviceId}>
                    {mic.label || `Mic ${mic.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>
            </div>

            {/* System audio button */}
            <button
              onClick={handleSelectSystemAudio}
              className={`flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg border text-xs font-medium
                         transition-all duration-150 whitespace-nowrap ${
                           audioSource === 'system'
                             ? 'border-rust-400 bg-rust-50 text-rust-700 shadow-sm shadow-rust-500/10'
                             : 'border-cream-300 bg-white text-charcoal-500 hover:border-cream-400'
                         }`}
            >
              <Monitor className="w-3.5 h-3.5" />
              {t('session.newSession.system')}
              {audioSource === 'system' && systemAudioStatus === 'granted' && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              )}
              {audioSource === 'system' && systemAudioStatus === 'requesting' && (
                <Loader2 className="w-3 h-3 animate-spin text-rust-500" />
              )}
            </button>
          </div>

          {audioSource === 'mic' && permissionState !== 'granted' && (
            <div className="flex items-center gap-2 mb-3 px-1">
              <span className="text-[11px] text-charcoal-400">{placeholderLabel}</span>
              <button
                onClick={() => void requestMicrophoneAccess()}
                className="text-[11px] text-rust-500 underline"
              >
                {t('common.retry')}
              </button>
            </div>
          )}

          {/* System audio status messages */}
          {audioSource === 'system' && systemAudioStatus === 'error' && (
            <div className="flex items-center gap-2 mb-3 px-1">
              <span className="text-[11px] text-red-500">{systemAudioError}</span>
              <button
                onClick={() => void requestSystemAudio()}
                className="text-[11px] text-rust-500 underline"
              >
                {t('common.retry')}
              </button>
            </div>
          )}
          {audioSource === 'system' && systemAudioStatus === 'granted' && (
            <div className="flex items-center gap-2 mb-3 px-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-[11px] text-emerald-700">{t('session.newSession.systemAudioReady')}</span>
            </div>
          )}

          {/* Folder selection */}
          <div className="mb-4">
            <div className="text-[10px] font-semibold text-charcoal-400 uppercase tracking-wider mb-1.5">
              {t('session.newSession.folder')}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => setFolderId('')}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium
                           border transition-colors ${
                             folderId === ''
                               ? 'border-rust-400 bg-rust-50 text-rust-700'
                               : 'border-cream-300 bg-white text-charcoal-500 hover:border-cream-400'
                           }`}
              >
                <Archive className="w-3 h-3" />
                {t('session.newSession.unfiled')}
              </button>

              {folders.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFolderId(f.id)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium
                             border transition-colors ${
                               folderId === f.id
                                 ? 'border-rust-400 bg-rust-50 text-rust-700'
                                 : 'border-cream-300 bg-white text-charcoal-500 hover:border-cream-400'
                             }`}
                >
                  <FolderOpen className="w-3 h-3" />
                  {f.name}
                </button>
              ))}

              {isCreatingFolder ? (
                <div className="inline-flex items-center gap-1">
                  <input
                    type="text"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleCreateFolder();
                      if (e.key === 'Escape') { setIsCreatingFolder(false); setNewFolderName(''); }
                    }}
                    placeholder={t('session.newSession.folderNamePlaceholder')}
                    autoFocus
                    className="w-24 px-2 py-1 rounded-md border border-rust-300 bg-white
                               text-xs text-charcoal-700 focus:outline-none focus:border-rust-400"
                  />
                  <button
                    onClick={() => void handleCreateFolder()}
                    disabled={folderCreating || !newFolderName.trim()}
                    className="w-6 h-6 flex items-center justify-center rounded-md
                               bg-rust-500 text-white hover:bg-rust-600
                               disabled:opacity-40 transition-colors"
                  >
                    {folderCreating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                  </button>
                  <button
                    onClick={() => { setIsCreatingFolder(false); setNewFolderName(''); }}
                    className="w-6 h-6 flex items-center justify-center rounded-md
                               text-charcoal-400 hover:bg-cream-100 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setIsCreatingFolder(true)}
                  className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium
                             border border-dashed border-cream-400 text-charcoal-400
                             hover:border-rust-300 hover:text-rust-500 transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  {t('session.newSession.newFolder')}
                </button>
              )}
            </div>
          </div>

          {/* Error */}
          {errorMsg && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg py-2 px-3 mb-3">
              {errorMsg}
            </div>
          )}

          {/* Start button */}
          <button
            onClick={handleStart}
            disabled={isStarting}
            className="w-full bg-rust-500 text-white py-3 rounded-xl
                       font-semibold text-sm tracking-wide
                       hover:bg-rust-600 active:bg-rust-700 transition-all duration-150
                       shadow-lg shadow-rust-500/25 hover:shadow-xl hover:shadow-rust-500/30
                       flex items-center justify-center gap-2
                       disabled:opacity-60 disabled:cursor-not-allowed
                       active:scale-[0.98]"
          >
            {isStarting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('session.newSession.starting')}
              </>
            ) : (
              <>
                {t('session.newSession.startRecording')}
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
