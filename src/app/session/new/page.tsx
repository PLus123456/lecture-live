'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useMicrophoneMonitor } from '@/hooks/useMicrophoneMonitor';
import { useAuth } from '@/hooks/useAuth';
import { useI18n } from '@/lib/i18n';
import { resolveSessionTerms } from '@/lib/keywords/sessionTerms';
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
  FolderOpen,
  Archive,
  Plus,
  Check,
  X,
} from 'lucide-react';

interface FolderItem {
  id: string;
  name: string;
  parentId: string | null;
}

export default function NewSessionPage() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const { user, token, restoreSession } = useAuth();
  const { t } = useI18n();
  const restoreAttempted = useRef(false);
  const restoreInFlight = useRef(false);
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const audioSource = useSettingsStore((s) => s.audioSource);
  const preferredMicDeviceId = useSettingsStore((s) => s.preferredMicDeviceId);
  const sourceLang = useSettingsStore((s) => s.sourceLang);
  const targetLang = useSettingsStore((s) => s.targetLang);
  const sonioxRegionPreference = useSettingsStore((s) => s.sonioxRegionPreference);
  const topic = useSettingsStore((s) => s.topic);
  const terms = useSettingsStore((s) => s.terms);
  const llmProvider = useSettingsStore((s) => s.llmProvider);
  const setAudioSource = useSettingsStore((s) => s.setAudioSource);
  const setPreferredMicDeviceId = useSettingsStore((s) => s.setPreferredMicDeviceId);
  const setSourceLang = useSettingsStore((s) => s.setSourceLang);
  const setTargetLang = useSettingsStore((s) => s.setTargetLang);
  const setSonioxRegionPreference = useSettingsStore((s) => s.setSonioxRegionPreference);
  const setTopic = useSettingsStore((s) => s.setTopic);
  const setPendingAutoStart = useSettingsStore((s) => s.setPendingAutoStart);
  const setPendingSessionTerms = useSettingsStore((s) => s.setPendingSessionTerms);
  const setPendingSystemStream = useSettingsStore((s) => s.setPendingSystemStream);

  const [sessionTitle, setSessionTitle] = useState('');
  const [folderId, setFolderId] = useState<string>('');
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // New folder inline creation
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderCreating, setFolderCreating] = useState(false);
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  // System audio
  const [systemAudioStatus, setSystemAudioStatus] = useState<
    'idle' | 'requesting' | 'granted' | 'error'
  >('idle');
  const [systemAudioError, setSystemAudioError] = useState<string | null>(null);
  const systemStreamRef = useRef<MediaStream | null>(null);

  const {
    activeDeviceId,
    availableMics,
    bars,
    error: microphoneError,
    level,
    peakDb,
    placeholderLabel,
    permissionState,
    requestAccess: requestMicrophoneAccess,
  } = useMicrophoneMonitor({
    enabled: audioSource === 'mic',
    preferredDeviceId: preferredMicDeviceId,
  });

  /* ---- Auth restore ---- */
  useEffect(() => {
    if (user && token) return;
    // restoreSession 正在进行中：StrictMode 双调用或快速重渲染时，不能误跳 /login
    if (restoreInFlight.current) return;
    if (!restoreAttempted.current) {
      restoreAttempted.current = true;
      restoreInFlight.current = true;
      restoreSession().then((ok) => {
        restoreInFlight.current = false;
        if (!ok) router.replace('/login');
      });
      return;
    }
    if (!user || !token) router.replace('/login');
  }, [user, token, router, restoreSession]);

  /* ---- Fetch folders ---- */
  const fetchFolders = useCallback(() => {
    if (!token) return;
    fetch('/api/folders', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setFolders(data); })
      .catch(() => {});
  }, [token]);

  useEffect(() => { fetchFolders(); }, [fetchFolders]);

  /* ---- Mic device fallback ---- */
  useEffect(() => {
    if (audioSource !== 'mic') return;
    const still = preferredMicDeviceId && availableMics.some((m) => m.deviceId === preferredMicDeviceId);
    if (still) return;
    const fb = activeDeviceId || availableMics[0]?.deviceId || null;
    if (fb !== preferredMicDeviceId) setPreferredMicDeviceId(fb);
  }, [activeDeviceId, availableMics, audioSource, preferredMicDeviceId, setPreferredMicDeviceId]);

  /* ---- System audio cleanup ---- */
  useEffect(() => {
    if (audioSource !== 'system' && systemStreamRef.current) {
      systemStreamRef.current.getTracks().forEach((t) => t.stop());
      systemStreamRef.current = null;
      setSystemAudioStatus('idle');
      setSystemAudioError(null);
    }
  }, [audioSource]);

  useEffect(() => {
    if (isMobile && audioSource === 'system') {
      setAudioSource('mic');
    }
  }, [audioSource, isMobile, setAudioSource]);

  useEffect(() => () => { systemStreamRef.current?.getTracks().forEach((t) => t.stop()); }, []);

  /* ---- Request system audio ---- */
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

  /* ---- Create folder inline ---- */
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

  /* ---- Derived labels ---- */
  const signalLabel =
    permissionState === 'requesting' ? t('session.newPage.signalRequesting')
    : permissionState !== 'granted' ? t('session.newPage.signalWaiting')
    : level >= 0.16 ? t('session.newPage.signalStrong')
    : level >= 0.05 ? t('session.newPage.signalOptimal')
    : level >= 0.015 ? t('session.newPage.signalLow')
    : t('session.newPage.signalSilent');

  const peakLabel = peakDb == null ? '-- dB' : `${peakDb.toFixed(1)} dB`;

  /* ---- Start session ---- */
  const handleStart = useCallback(async () => {
    if (isStarting) return;
    if (!token) { router.push('/login'); return; }
    setIsStarting(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: sessionTitle || t('session.defaultTitle'),
          courseName: topic || undefined,
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
          data.error || t('session.newSession.failedToCreateSession', { status: res.status })
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
      if (audioSource === 'system' && systemStreamRef.current) {
        setPendingSystemStream(systemStreamRef.current);
        systemStreamRef.current = null;
      }
      setIsStarting(false);
      setPendingAutoStart(true);
      router.push(`/session/${session.id}`);
    } catch {
      setErrorMsg(t('session.newSession.networkError'));
      setIsStarting(false);
    }
  }, [
    isStarting, token, router, sessionTitle,
    sourceLang, targetLang, folderId, audioSource,
    preferredMicDeviceId, activeDeviceId, availableMics,
    setPendingAutoStart, setPendingSessionTerms, setPendingSystemStream,
    setPreferredMicDeviceId, sonioxRegionPreference, topic, terms, llmProvider, t,
  ]);

  /* ---- Loading guard ---- */
  if (!user || !token) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-cream-50">
        <div className="text-charcoal-400 text-sm">{t('playback.redirectingToLogin')}</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-cream-50 overflow-hidden">
      {!isMobile ? <Sidebar /> : null}
      <main
        className={`flex-1 flex flex-col transition-all duration-300 ${
          isMobile ? 'ml-0 overflow-y-auto' : sidebarCollapsed ? 'ml-16' : 'ml-56'
        }`}
      >
        <div className={`flex-1 flex flex-col mx-auto w-full ${isMobile ? 'px-4 py-5 max-w-none pb-24' : 'px-10 py-8 max-w-3xl'}`}>
          {isMobile ? (
            <div className="mb-5 flex items-center gap-3">
              <button
                onClick={() => router.push('/home')}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-charcoal-600 shadow-sm"
                aria-label={t('session.newPage.backToHome')}
              >
                <span className="text-lg leading-none">←</span>
              </button>
              <div>
                <h1 className="font-serif text-xl font-bold text-charcoal-800">{t('session.newPage.title')}</h1>
                <p className="text-xs text-charcoal-400">{t('session.newPage.subtitle')}</p>
              </div>
            </div>
          ) : null}
          {/* ── Title ── */}
          <input
            type="text"
            value={sessionTitle}
            onChange={(e) => setSessionTitle(e.target.value)}
            placeholder={t('session.newPage.untitledPlaceholder')}
            className="bg-transparent border-none outline-none
                       font-serif font-bold text-charcoal-800
                       placeholder:text-charcoal-300 placeholder:font-normal
                       mb-6"
            style={{ fontSize: isMobile ? '1.5rem' : '1.875rem' }}
          />

          {/* ── Settings rows ── */}
          <div className="space-y-4 flex-1">
            {/* Language row */}
            <div className={`${isMobile ? 'rounded-2xl border border-cream-200 bg-white p-4 space-y-3' : 'flex items-center gap-3'}`}>
              <label className={`text-xs font-medium text-charcoal-400 uppercase tracking-wider ${isMobile ? 'block' : 'w-20 shrink-0'}`}>
                {t('session.newPage.source')}
              </label>
              <LanguageSelect
                value={sourceLang}
                onChange={setSourceLang}
                className={isMobile ? 'w-full' : 'flex-1 max-w-[200px]'}
              />

              {isMobile ? (
                <div className="flex justify-center">
                  <span className="text-charcoal-300">↓</span>
                </div>
              ) : (
                <ArrowRight className="w-4 h-4 text-charcoal-300 shrink-0" />
              )}

              <label className={`text-xs font-medium text-charcoal-400 uppercase tracking-wider ${isMobile ? 'block' : 'shrink-0'}`}>
                {t('session.newPage.translate')}
              </label>
              <LanguageSelect
                value={targetLang}
                onChange={setTargetLang}
                allowNone
                noneLabel={t('session.newSession.targetNone')}
                excludeCodes={[sourceLang]}
                className={isMobile ? 'w-full' : 'flex-1 max-w-[200px]'}
              />
            </div>

            {/* Topic row */}
            <div className={`${isMobile ? 'rounded-2xl border border-cream-200 bg-white p-4 space-y-2' : 'flex items-center gap-3'}`}>
              <label className={`text-xs font-medium text-charcoal-400 uppercase tracking-wider ${isMobile ? 'block' : 'w-20 shrink-0'}`}>
                {t('session.newPage.topic')}
              </label>
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={t('session.newPage.topicPlaceholder')}
                className={`${isMobile ? 'w-full' : 'flex-1'} px-3 py-2 rounded-lg border border-cream-300 bg-white
                           text-sm text-charcoal-700 placeholder:text-charcoal-300
                           focus:outline-none focus:border-rust-300`}
              />
            </div>

            <div className={`${isMobile ? 'rounded-2xl border border-cream-200 bg-white p-4 space-y-2' : 'flex items-center gap-3'}`}>
              <label className={`text-xs font-medium text-charcoal-400 uppercase tracking-wider ${isMobile ? 'block' : 'w-20 shrink-0'}`}>
                {t('session.newPage.region')}
              </label>
              <select
                value={sonioxRegionPreference}
                onChange={(e) => setSonioxRegionPreference(e.target.value as typeof sonioxRegionPreference)}
                className={`${isMobile ? 'w-full' : 'flex-1 max-w-[260px]'} px-3 py-2 rounded-lg border border-cream-300 bg-white
                           text-sm text-charcoal-700 focus:outline-none focus:border-rust-300`}
              >
                {SONIOX_REGION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-charcoal-400">
                {t('session.newPage.autoRegionHint')}
              </p>
            </div>

            {/* Folder row */}
            <div className={`${isMobile ? 'rounded-2xl border border-cream-200 bg-white p-4 space-y-3' : 'flex items-center gap-3'}`}>
              <label className={`text-xs font-medium text-charcoal-400 uppercase tracking-wider ${isMobile ? 'block' : 'w-20 shrink-0'}`}>
                {t('session.newPage.folder')}
              </label>
              <div className={`flex items-center gap-1.5 ${isMobile ? 'overflow-x-auto pb-2 mobile-scroll' : 'flex-wrap'}`}>
                {/* Unfiled */}
                <button
                  onClick={() => setFolderId('')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                             border transition-colors ${
                               folderId === ''
                                 ? 'border-rust-400 bg-rust-50 text-rust-700'
                                 : 'border-cream-300 bg-white text-charcoal-500 hover:border-cream-400'
                             }`}
                >
                  <Archive className="w-3 h-3" />
                  {t('session.newSession.unfiled')}
                </button>

                {/* Existing folders */}
                {folders.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setFolderId(f.id)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
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

                {/* New folder inline */}
                {isCreatingFolder ? (
                  <div className="inline-flex items-center gap-1">
                    <input
                      ref={newFolderInputRef}
                      type="text"
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleCreateFolder();
                        if (e.key === 'Escape') { setIsCreatingFolder(false); setNewFolderName(''); }
                      }}
                      placeholder={t('session.newSession.folderNamePlaceholder')}
                      autoFocus
                      className="w-28 px-2 py-1 rounded-md border border-rust-300 bg-white
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
                    onClick={() => { setIsCreatingFolder(true); }}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium
                               border border-dashed border-cream-400 text-charcoal-400
                               hover:border-rust-300 hover:text-rust-500 transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    {t('session.newSession.newFolder')}
                  </button>
                )}
              </div>
            </div>

            {/* ── Audio input compact widget ── */}
            <div className={`${isMobile ? 'rounded-2xl border border-cream-200 bg-white p-4 space-y-3' : 'flex items-start gap-3 pt-2'}`}>
              <label className={`text-xs font-medium text-charcoal-400 uppercase tracking-wider ${isMobile ? 'block' : 'w-20 shrink-0 pt-2'}`}>
                {t('session.newPage.audio')}
              </label>

              <div className={`flex gap-2 ${isMobile ? 'w-full' : ''}`}>
                {/* Mic button */}
                <button
                  onClick={() => {
                    setAudioSource('mic');
                    void requestMicrophoneAccess();
                  }}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium
                             transition-colors ${
                               audioSource === 'mic'
                                 ? 'border-rust-400 bg-rust-50 text-rust-700'
                                 : 'border-cream-300 bg-white text-charcoal-500 hover:border-cream-400'
                             } ${isMobile ? 'flex-1 justify-center' : ''}`}
                >
                  <Mic className="w-3.5 h-3.5" />
                  {t('session.newSession.microphone')}
                </button>

                {/* System audio button */}
                {!isMobile ? (
                  <button
                    onClick={handleSelectSystemAudio}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium
                               transition-colors ${
                                 audioSource === 'system'
                                   ? 'border-rust-400 bg-rust-50 text-rust-700'
                                   : 'border-cream-300 bg-white text-charcoal-500 hover:border-cream-400'
                               }`}
                    >
                      <Monitor className="w-3.5 h-3.5" />
                    {t('session.newPage.systemAudio')}
                    {audioSource === 'system' && systemAudioStatus === 'granted' && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    )}
                    {audioSource === 'system' && systemAudioStatus === 'requesting' && (
                      <Loader2 className="w-3 h-3 animate-spin text-rust-500" />
                    )}
                  </button>
                ) : null}
              </div>
            </div>

            {/* Mic details (inline, compact) */}
            {audioSource === 'mic' && (
              <div className={`flex items-center gap-3 ${isMobile ? 'rounded-2xl border border-cream-200 bg-white p-4 flex-wrap' : 'ml-[calc(5rem+0.75rem)]'}`}>
                {/* Device selector */}
                <select
                  value={preferredMicDeviceId ?? activeDeviceId ?? ''}
                  onChange={(e) => setPreferredMicDeviceId(e.target.value || null)}
                  className={`${isMobile ? 'w-full' : 'w-48'} text-xs px-2.5 py-1.5 rounded-md border border-cream-300
                             bg-white text-charcoal-600 focus:outline-none focus:border-rust-300`}
                >
                  {availableMics.length === 0 && (
                    <option value="">{placeholderLabel}</option>
                  )}
                  {availableMics.map((mic) => (
                    <option key={mic.deviceId} value={mic.deviceId}>
                      {mic.label || `Mic ${mic.deviceId.slice(0, 8)}`}
                    </option>
                  ))}
                </select>

                {/* Mini visualizer */}
                <div className="flex items-end gap-px h-6">
                  {bars.map((bar, i) => (
                    <div
                      key={`${i}-${preferredMicDeviceId ?? 'def'}`}
                      className="w-[3px] bg-rust-400 rounded-full transition-all duration-75"
                      style={{
                        height: `${Math.max(12, Math.round(bar * 100))}%`,
                        opacity: permissionState === 'granted'
                          ? Math.min(1, 0.35 + bar * 0.8)
                          : 0.2,
                      }}
                    />
                  ))}
                </div>

                {/* Signal info */}
                <span className={`text-[10px] font-medium ${
                  permissionState === 'granted' ? 'text-emerald-600'
                  : microphoneError ? 'text-red-500'
                  : 'text-charcoal-400'
                }`}>
                  {microphoneError || signalLabel}
                </span>
                <span className="text-[10px] text-charcoal-400">{peakLabel}</span>
                {permissionState !== 'granted' && (
                  <button
                    onClick={() => void requestMicrophoneAccess()}
                    className="text-[10px] text-rust-500 underline underline-offset-2"
                  >
                    {t('session.newPage.retryMicAccess')}
                  </button>
                )}
              </div>
            )}

            {/* System audio status */}
            {audioSource === 'system' && systemAudioStatus === 'error' && (
              <div className={`${isMobile ? 'rounded-2xl border border-red-200 bg-red-50 p-4' : 'ml-[calc(5rem+0.75rem)]'} flex items-center gap-2`}>
                <span className="text-xs text-red-500">{systemAudioError}</span>
                <button
                  onClick={() => void requestSystemAudio()}
                  className="text-xs text-rust-500 underline"
                >
                  {t('common.retry')}
                </button>
              </div>
            )}
            {audioSource === 'system' && systemAudioStatus === 'granted' && (
              <div className={`${isMobile ? 'rounded-2xl border border-emerald-200 bg-emerald-50 p-4' : 'ml-[calc(5rem+0.75rem)]'} flex items-center gap-2`}>
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-xs text-emerald-700">{t('session.newPage.systemAudioStreaming')}</span>
              </div>
            )}
          </div>

          {/* ── Error + Start ── */}
          <div className="pt-6 pb-2 flex flex-col items-center gap-3">
            {errorMsg && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg py-2 px-4">
                {errorMsg}
              </div>
            )}
            <button
              onClick={handleStart}
              disabled={isStarting}
              className={`bg-rust-500 text-white rounded-xl
                        font-semibold text-sm uppercase tracking-wider
                        hover:bg-rust-600 active:bg-rust-700 transition-colors
                        shadow-lg shadow-rust-500/25
                        flex items-center gap-2
                        disabled:opacity-60 disabled:cursor-not-allowed ${
                          isMobile ? 'w-full justify-center px-4 py-3' : 'px-10 py-3'
                        }`}
            >
              {isStarting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('session.newPage.creating')}
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
      </main>
    </div>
  );
}
