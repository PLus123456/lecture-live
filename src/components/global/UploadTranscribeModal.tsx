'use client';

/**
 * 拖入文件后的配置 + 进度 modal。
 *
 * 两个阶段：
 * - configuring：用户选择语言、folder，然后点"开始转录"
 * - running：modal 显示进度条，可"最小化"到后台或取消
 *
 * 转录走 Soniox async file API：分片上传 → 后端 ffmpeg → 后端传 Soniox → 后端 poll
 * → 前端在 status endpoint 上轮询。视频文件会被后端抽出音频，压成 mono 128kbps MP3。
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  X,
  ArrowRight,
  FileAudio,
  Loader2,
  Minimize2,
  CheckCircle2,
  AlertTriangle,
  FolderOpen,
  Archive,
} from 'lucide-react';
import ModalPortal from '@/components/ModalPortal';
import ConfirmDialog from '@/components/ConfirmDialog';
import LanguageSelect from '@/components/LanguageSelect';
import { useAuth } from '@/hooks/useAuth';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';
import { useUploadJobsStore, uploadJobs, type UploadJobStatus } from '@/stores/uploadJobsStore';
import { probeAudioDurationMs } from '@/lib/transcribe/fileTranscriber';
import {
  startAsyncUpload,
  estimateAsyncTranscribeMs,
} from '@/lib/transcribe/asyncUploadClient';
import { formatBytes } from '@/lib/format';

interface FolderItem {
  id: string;
  name: string;
  parentId: string | null;
}

interface Props {
  file: File;
  onClose: () => void;
  onNavigate: (sessionId: string) => void;
}

const formatDurationCompact = (ms: number) => {
  if (!ms || !Number.isFinite(ms)) return '--';
  const sec = Math.round(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

export default function UploadTranscribeModal({ file, onClose, onNavigate }: Props) {
  const { t, locale } = useI18n();
  const { token } = useAuth();

  const sourceLang = useSettingsStore((s) => s.sourceLang);
  const targetLang = useSettingsStore((s) => s.targetLang);
  const setSourceLang = useSettingsStore((s) => s.setSourceLang);
  const setTargetLang = useSettingsStore((s) => s.setTargetLang);
  const sonioxRegionPreference = useSettingsStore((s) => s.sonioxRegionPreference);

  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [folderId, setFolderId] = useState<string>('');
  const [audioDurationMs, setAudioDurationMs] = useState<number>(0);
  const [phase, setPhase] = useState<'configuring' | 'running'>('configuring');
  const [jobId, setJobId] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  const job = useUploadJobsStore((s) => (jobId ? s.jobs[jobId] : undefined));

  // ── 文件元数据（视频文件浏览器可能拿不到时长，忽略即可，后端 ffprobe 是真相） ──
  useEffect(() => {
    let canceled = false;
    probeAudioDurationMs(file)
      .then((ms) => { if (!canceled) setAudioDurationMs(ms); })
      .catch(() => { /* ignore */ });
    return () => { canceled = true; };
  }, [file]);

  // ── 加载 folder 列表 ──
  useEffect(() => {
    if (!token) return;
    fetch('/api/folders', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setFolders(data); })
      .catch(() => { /* ignore */ });
  }, [token]);

  // ── 估算耗时 ──
  // 视频文件浏览器经常拿不到 <audio>.duration（容器/codec 不支持），audioDurationMs=0
  // 会让 estimateAsyncTranscribeMs 漏算 Soniox 处理时间，估算严重偏低。这里按文件大小
  // 粗估一个 fallback：视频按 ~5MB/min，音频按 ~1MB/min。
  const effectiveDurationMs = useMemo(() => {
    if (audioDurationMs > 0) return audioDurationMs;
    const isVideo = /^video\//i.test(file.type);
    const mbPerMin = isVideo ? 5 : 1;
    return Math.round((file.size / (mbPerMin * 1024 * 1024)) * 60_000);
  }, [audioDurationMs, file.size, file.type]);

  const estimateMs = useMemo(
    () => estimateAsyncTranscribeMs(file.size, effectiveDurationMs),
    [file.size, effectiveDurationMs]
  );

  const estimateText = useMemo(() => {
    if (!estimateMs) return '--';
    if (estimateMs < 60_000) {
      return t('upload.aboutSec', { n: Math.max(1, Math.round(estimateMs / 1000)) });
    }
    return t('upload.aboutMin', { n: Math.max(1, Math.round(estimateMs / 60_000)) });
  }, [estimateMs, t]);

  // ── 启动转录 ──
  const handleStart = useCallback(async () => {
    if (phase === 'running' || !token) return;
    setErrorMsg(null);

    // 1. 创建本地 job
    const id = uploadJobs.create({
      fileName: file.name,
      fileSize: file.size,
      durationMs: audioDurationMs,
      estimatedDurationMs: estimateMs,
      startedAt: Date.now(),
      sourceLang,
      targetLang,
      folderId: folderId || null,
    });
    setJobId(id);
    setPhase('running');

    try {
      // 2. 创建 session
      uploadJobs.update(id, { status: 'creating' });
      const now = new Date();
      const autoTitle = now.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      const sessionRes = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: `${file.name.replace(/\.[^.]+$/, '')} · ${autoTitle}`,
          sourceLang,
          targetLang,
          audioSource: 'microphone',
          sonioxRegion: sonioxRegionPreference,
          folderId: folderId || undefined,
        }),
      });
      if (!sessionRes.ok) throw new Error(t('upload.failedCreateSession'));
      const session = (await sessionRes.json()) as { id: string };
      uploadJobs.update(id, { sessionId: session.id });

      // 3. 启动 async upload pipeline（分片上传 + finalize + poll）
      const handle = startAsyncUpload({
        file,
        sessionId: session.id,
        authToken: token,
        onUploadProgress: (p) => uploadJobs.update(id, { uploadProgress: p }),
        onProcessingProgress: (p) =>
          uploadJobs.update(id, { processingProgress: p }),
        onStatusChange: (status) => {
          uploadJobs.update(id, { status: status as UploadJobStatus });
        },
      });
      cancelRef.current = handle.cancel;
      uploadJobs.registerCancel(id, async () => {
        handle.cancel();
        // 同时请求服务端取消（后端会清理 chunks + Soniox 文件）
        await fetch(`/api/sessions/${session.id}/async-upload`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => undefined);
      });

      const result = await handle.promise;
      cancelRef.current = null;
      uploadJobs.unregisterCancel(id);

      if (result.finalStatus === 'completed') {
        uploadJobs.update(id, { status: 'completed' });
        toast.show({
          type: 'success',
          message: `${t('upload.uploadDone')} · ${file.name}`,
          description: t('upload.uploadDoneDesc'),
          duration: 0,
          action: {
            label: t('upload.openPlayback'),
            onClick: () => onNavigate(session.id),
          },
        });
      } else if (result.finalStatus === 'failed') {
        const msg = result.error || t('upload.failed');
        uploadJobs.update(id, { status: 'failed', errorMessage: msg });
        setErrorMsg(msg);
        toast.error(t('upload.failed'), msg);
      } else if (result.finalStatus === 'canceled') {
        uploadJobs.update(id, { status: 'canceled' });
      }
    } catch (err) {
      // 用户点取消时 abort signal 会让 fetch/sleep 抛 AbortError。
      // asyncUploadClient 顶层 catch 一般会转成 finalStatus='canceled'，但保险起见
      // 这里也识别一遍，避免把取消当失败弹错 toast。
      const isAbort =
        (err instanceof DOMException && err.name === 'AbortError') ||
        (err instanceof Error && err.name === 'AbortError');
      if (isAbort) {
        uploadJobs.update(id, { status: 'canceled' });
        uploadJobs.unregisterCancel(id);
        return;
      }
      const msg = err instanceof Error ? err.message : t('upload.failed');
      uploadJobs.update(id, { status: 'failed', errorMessage: msg });
      uploadJobs.unregisterCancel(id);
      setErrorMsg(msg);
      toast.error(t('upload.failed'), msg);
    }
  }, [
    phase, token, file, audioDurationMs, estimateMs, sourceLang, targetLang,
    folderId, sonioxRegionPreference, locale, t, onNavigate,
  ]);

  // ── 取消 ──
  const handleCancel = useCallback(() => {
    if (
      phase === 'running' &&
      job &&
      job.status !== 'completed' &&
      job.status !== 'failed' &&
      job.status !== 'canceled'
    ) {
      setCancelDialogOpen(true);
      return;
    }
    onClose();
  }, [phase, job, onClose]);

  const handleCancelConfirm = useCallback(() => {
    setCancelDialogOpen(false);
    if (jobId) uploadJobs.cancel(jobId);
    cancelRef.current = null;
    onClose();
  }, [jobId, onClose]);

  const handleMinimize = useCallback(() => {
    onClose();
  }, [onClose]);

  // ── ESC 关闭 ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (phase === 'configuring') onClose();
        else handleMinimize();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [phase, onClose, handleMinimize]);

  // ── 渲染 ──
  const isRunning = phase === 'running';
  const isDone = job?.status === 'completed';
  const isFailed = job?.status === 'failed';

  const statusLabel = (() => {
    if (!job) return '';
    switch (job.status) {
      case 'creating': return t('upload.creatingSession');
      case 'uploading_chunks': return t('upload.uploadingAudio');
      case 'transcoding': return t('upload.transcoding');
      case 'uploading_to_soniox': return t('upload.uploadingToSoniox');
      case 'transcribing': return t('upload.transcribing');
      case 'finalizing': return t('upload.finalizing');
      case 'completed': return t('upload.uploadDone');
      case 'failed': return t('upload.failed');
      case 'canceled': return t('upload.cancel');
      default: return '';
    }
  })();

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[1200] flex items-center justify-center">
        <div
          className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-backdrop-enter"
          onClick={() => { if (!isRunning || isDone || isFailed) onClose(); }}
        />

        <div
          className="relative w-[440px] max-w-[92vw] bg-white rounded-2xl shadow-2xl border border-cream-200 overflow-hidden animate-modal-enter"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 头部 */}
          <div className="flex items-start gap-3 px-5 pt-5 pb-3 border-b border-cream-200">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rust-50 flex-shrink-0">
              <FileAudio className="h-5 w-5 text-rust-500" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-serif text-base font-bold text-charcoal-800 truncate">
                {file.name}
              </h2>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-charcoal-400">
                <span>{formatBytes(file.size)}</span>
                <span>·</span>
                <span>{audioDurationMs ? formatDurationCompact(audioDurationMs) : '...'}</span>
              </div>
            </div>
            <button
              onClick={isRunning && !isDone && !isFailed ? handleMinimize : onClose}
              className="w-7 h-7 flex items-center justify-center rounded-md text-charcoal-400 hover:bg-cream-100 hover:text-charcoal-600 transition-colors flex-shrink-0"
              title={isRunning && !isDone && !isFailed ? t('upload.minimize') : ''}
            >
              {isRunning && !isDone && !isFailed ? <Minimize2 className="h-3.5 w-3.5" /> : <X className="h-4 w-4" />}
            </button>
          </div>

          {/* 内容 */}
          <div className="px-5 py-4">
            {phase === 'configuring' && (
              <>
                <div className="text-[10px] font-semibold text-charcoal-400 uppercase tracking-wider mb-1.5">
                  {t('upload.sourceLang')} → {t('upload.targetLang')}
                </div>
                <div className="flex items-center gap-2 mb-3">
                  <LanguageSelect value={sourceLang} onChange={setSourceLang} className="flex-1" />
                  <ArrowRight className="w-4 h-4 text-charcoal-300 shrink-0" />
                  <LanguageSelect
                    value={targetLang}
                    onChange={setTargetLang}
                    allowNone
                    excludeCodes={[sourceLang]}
                    className="flex-1"
                  />
                </div>

                <div className="text-[10px] font-semibold text-charcoal-400 uppercase tracking-wider mb-1.5">
                  {t('upload.folder')}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap mb-3">
                  <button
                    onClick={() => setFolderId('')}
                    className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      folderId === ''
                        ? 'border-rust-400 bg-rust-50 text-rust-700'
                        : 'border-cream-300 bg-white text-charcoal-500 hover:border-cream-400'
                    }`}
                  >
                    <Archive className="w-3 h-3" />
                    {t('upload.unfiled')}
                  </button>
                  {folders.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setFolderId(f.id)}
                      className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        folderId === f.id
                          ? 'border-rust-400 bg-rust-50 text-rust-700'
                          : 'border-cream-300 bg-white text-charcoal-500 hover:border-cream-400'
                      }`}
                    >
                      <FolderOpen className="w-3 h-3" />
                      {f.name}
                    </button>
                  ))}
                </div>

                {/* 估算 */}
                <div className="flex items-center justify-between rounded-lg bg-cream-50 border border-cream-200 px-3 py-2 text-xs mb-4">
                  <span className="text-charcoal-500">{t('upload.estimateLabel')}</span>
                  <span className="font-semibold text-charcoal-700 tabular-nums">{estimateText}</span>
                </div>

                <button
                  onClick={() => void handleStart()}
                  className="w-full bg-rust-500 text-white py-2.5 rounded-xl font-semibold text-sm
                             hover:bg-rust-600 active:bg-rust-700 transition-all duration-150
                             shadow-lg shadow-rust-500/25
                             flex items-center justify-center gap-2"
                >
                  {t('upload.startButton')}
                  <ArrowRight className="w-4 h-4" />
                </button>
              </>
            )}

            {phase === 'running' && job && (
              <>
                {/* 进度条 */}
                <div className="mb-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium text-charcoal-700 flex items-center gap-1.5">
                      {isDone ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                      ) : isFailed ? (
                        <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                      ) : (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-rust-500" />
                      )}
                      {statusLabel}
                    </span>
                    <span className="text-xs text-charcoal-400 tabular-nums">
                      {Math.round(job.progress * 100)}%
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-cream-200">
                    <div
                      className={`h-full rounded-full transition-[width] duration-300 ${
                        isFailed ? 'bg-red-400' : isDone ? 'bg-emerald-500' : 'bg-gradient-to-r from-rust-400 to-rust-500'
                      }`}
                      style={{ width: `${job.progress * 100}%` }}
                    />
                  </div>
                </div>

                {/* 错误信息 */}
                {errorMsg && (
                  <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg py-2 px-3 mb-3">
                    {errorMsg}
                  </div>
                )}

                {/* 阶段细节 */}
                {!isDone && !isFailed && job.status === 'uploading_chunks' && (
                  <div className="text-[11px] text-charcoal-400 mb-3">
                    <div className="flex justify-between">
                      <span>{t('upload.uploadingAudio')}</span>
                      <span className="tabular-nums">{Math.round(job.uploadProgress * 100)}%</span>
                    </div>
                  </div>
                )}

                {/* 操作按钮 */}
                {isDone && job.sessionId ? (
                  <button
                    onClick={() => { onNavigate(job.sessionId!); onClose(); }}
                    className="w-full bg-rust-500 text-white py-2.5 rounded-xl font-semibold text-sm
                               hover:bg-rust-600 active:bg-rust-700 transition-all flex items-center justify-center gap-2"
                  >
                    {t('upload.openPlayback')}
                    <ArrowRight className="w-4 h-4" />
                  </button>
                ) : isFailed ? (
                  <button
                    onClick={onClose}
                    className="w-full bg-charcoal-100 text-charcoal-700 py-2.5 rounded-xl font-medium text-sm
                               hover:bg-charcoal-200 transition-all"
                  >
                    {t('upload.cancel')}
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={handleMinimize}
                      className="flex-1 bg-cream-100 text-charcoal-700 py-2.5 rounded-xl font-medium text-sm
                                 hover:bg-cream-200 transition-all flex items-center justify-center gap-1.5"
                    >
                      <Minimize2 className="w-3.5 h-3.5" />
                      {t('upload.minimize')}
                    </button>
                    <button
                      onClick={handleCancel}
                      className="flex-1 bg-red-50 text-red-700 py-2.5 rounded-xl font-medium text-sm
                                 hover:bg-red-100 transition-all"
                    >
                      {t('upload.cancel')}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={cancelDialogOpen}
        title={t('upload.cancel')}
        message={t('upload.confirmCancel')}
        confirmText={t('upload.cancel')}
        cancelText={t('upload.keepRunning')}
        danger
        onConfirm={handleCancelConfirm}
        onCancel={() => setCancelDialogOpen(false)}
      />
    </ModalPortal>
  );
}
