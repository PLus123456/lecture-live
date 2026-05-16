'use client';

/**
 * 上传转录任务的全局后台 widget。
 *
 * 两类来源：
 * 1. 本进程内 UploadTranscribeModal 启动的 job —— modal 关闭后仍在 uploadJobsStore 跑，
 *    此 widget 订阅 store 给它进度可见性 + 取消能力。
 * 2. 刷新页面后的"僵尸 session" —— uploadJobsStore 已持久化到 localStorage，但分片上传的
 *    File 句柄、轮询循环都随页面销毁了。挂载时拉 /api/sessions/active-async 把它们找回来：
 *      - 进行中（transcoding..finalizing）→ 重新挂 poll（poll 驱动服务端收尾，不挂就永远卡住）
 *      - uploading_chunks → File 已丢失无法续传 → 清理服务端 + 标记为"上传中断"失败
 *      - failed → 在失败区展示出来
 *
 * UI：屏幕右下悬浮卡片，进行中的 job 显示进度 + 取消按钮；失败的 job 单列一区，
 * 提供"删除会话" / "忽略"。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, FileAudio, Loader2, ChevronDown, ChevronUp, AlertTriangle, Trash2 } from 'lucide-react';
import { useUploadJobsStore, uploadJobs, type UploadJob } from '@/stores/uploadJobsStore';
import {
  pollAsyncTranscribeStatus,
  type AsyncUploadStatus,
} from '@/lib/transcribe/asyncUploadClient';
import { useAuth } from '@/hooks/useAuth';
import { useI18n } from '@/lib/i18n';

const ACTIVE_STATUSES: UploadJob['status'][] = [
  'pending',
  'creating',
  'uploading_chunks',
  'transcoding',
  'uploading_to_soniox',
  'transcribing',
  'finalizing',
];

/** 服务端 active-async endpoint 里"仍在跑"的状态（不含 failed）。 */
const SERVER_RUNNING_STATUSES = [
  'transcoding',
  'uploading_to_soniox',
  'transcribing',
  'finalizing',
];

interface ActiveAsyncJob {
  id: string;
  title: string | null;
  asyncTranscribeStatus: string;
  asyncTranscribeError: string | null;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export default function UploadJobsTracker() {
  const { t } = useI18n();
  const { token } = useAuth();
  const jobs = useUploadJobsStore((s) => s.jobs);
  const [collapsed, setCollapsed] = useState(false);
  // store 从 localStorage 复水后才渲染，避免 SSR（空 store）与客户端 hydration 不一致
  const [mounted, setMounted] = useState(false);
  const reconciledRef = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // ── 刷新后的僵尸 session 找回（每次会话只跑一次） ──
  useEffect(() => {
    if (!token || reconciledRef.current) return;
    reconciledRef.current = true;
    void reconcileOrphans(token, t);
  }, [token, t]);

  const handleCancel = useCallback((id: string) => {
    uploadJobs.cancel(id);
  }, []);

  const handleDeleteSession = useCallback(
    async (job: UploadJob) => {
      if (job.sessionId && token) {
        await fetch(`/api/sessions/${job.sessionId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => undefined);
      }
      uploadJobs.remove(job.id);
    },
    [token],
  );

  const handleDismiss = useCallback((id: string) => {
    uploadJobs.remove(id);
  }, []);

  const allJobs = Object.values(jobs);
  const activeJobs = allJobs.filter((j) => ACTIVE_STATUSES.includes(j.status));
  const failedJobs = allJobs.filter((j) => j.status === 'failed');

  if (!mounted) return null;
  if (activeJobs.length === 0 && failedJobs.length === 0) return null;

  const headerCount = activeJobs.length + failedJobs.length;

  return (
    <div className="fixed bottom-4 right-4 z-[1100] w-[300px] max-w-[calc(100vw-2rem)]">
      <div className="bg-white dark:bg-charcoal-800 border border-cream-200 dark:border-charcoal-700 rounded-2xl shadow-2xl overflow-hidden">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 bg-cream-50 dark:bg-charcoal-900/50 border-b border-cream-200 dark:border-charcoal-700 hover:bg-cream-100 dark:hover:bg-charcoal-900 transition-colors"
        >
          <div className="flex items-center gap-2 min-w-0">
            {activeJobs.length > 0 ? (
              <Loader2 className="w-3.5 h-3.5 text-rust-500 animate-spin shrink-0" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0" />
            )}
            <span className="text-xs font-semibold text-charcoal-700 dark:text-cream-200 truncate">
              {t('upload.bgPanelTitle', { count: headerCount })}
            </span>
          </div>
          {collapsed ? (
            <ChevronUp className="w-3.5 h-3.5 text-charcoal-400 shrink-0" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-charcoal-400 shrink-0" />
          )}
        </button>

        {!collapsed && (
          <div className="max-h-[60vh] overflow-y-auto">
            {activeJobs.length > 0 && (
              <div className="divide-y divide-cream-100 dark:divide-charcoal-700">
                {activeJobs.map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    onCancel={() => handleCancel(job.id)}
                    statusLabel={statusLabel(job.status, t)}
                  />
                ))}
              </div>
            )}

            {failedJobs.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-3.5 py-2 bg-red-50/70 dark:bg-red-900/15 border-y border-red-100 dark:border-red-900/30">
                  <AlertTriangle className="w-3 h-3 text-red-500 shrink-0" />
                  <span className="text-[11px] font-semibold text-red-600 dark:text-red-400">
                    {t('upload.failedSectionTitle', { count: failedJobs.length })}
                  </span>
                </div>
                <div className="divide-y divide-cream-100 dark:divide-charcoal-700">
                  {failedJobs.map((job) => (
                    <FailedJobRow
                      key={job.id}
                      job={job}
                      onDeleteSession={() => void handleDeleteSession(job)}
                      onDismiss={() => handleDismiss(job.id)}
                      deleteLabel={t('upload.deleteSession')}
                      dismissLabel={t('upload.dismiss')}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface JobRowProps {
  job: UploadJob;
  onCancel: () => void;
  statusLabel: string;
}

function JobRow({ job, onCancel, statusLabel }: JobRowProps) {
  const percent = Math.round(Math.min(1, Math.max(0, job.progress)) * 100);

  return (
    <div className="px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-rust-50 dark:bg-rust-900/30 flex-shrink-0">
          <FileAudio className="h-4 w-4 text-rust-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-charcoal-800 dark:text-cream-100 truncate">
            {job.fileName}
          </div>
          <div className="mt-0.5 text-[10px] text-charcoal-400 dark:text-charcoal-300">
            {statusLabel} · {percent}%
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="w-6 h-6 flex items-center justify-center rounded-md text-charcoal-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex-shrink-0"
          aria-label="cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 h-1 w-full rounded-full bg-cream-100 dark:bg-charcoal-700 overflow-hidden">
        <div
          className="h-full bg-rust-500 transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

interface FailedJobRowProps {
  job: UploadJob;
  onDeleteSession: () => void;
  onDismiss: () => void;
  deleteLabel: string;
  dismissLabel: string;
}

function FailedJobRow({
  job,
  onDeleteSession,
  onDismiss,
  deleteLabel,
  dismissLabel,
}: FailedJobRowProps) {
  return (
    <div className="px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-50 dark:bg-red-900/30 flex-shrink-0">
          <AlertTriangle className="h-4 w-4 text-red-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-charcoal-800 dark:text-cream-100 truncate">
            {job.fileName}
          </div>
          {job.errorMessage && (
            <div className="mt-0.5 text-[10px] text-red-500 dark:text-red-400 break-words line-clamp-3">
              {job.errorMessage}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={onDeleteSession}
          className="flex-1 inline-flex items-center justify-center gap-1 rounded-md bg-red-50 dark:bg-red-900/20 px-2 py-1.5 text-[11px] font-medium text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
        >
          <Trash2 className="h-3 w-3" />
          {deleteLabel}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="flex-1 rounded-md bg-cream-100 dark:bg-charcoal-700 px-2 py-1.5 text-[11px] font-medium text-charcoal-600 dark:text-cream-200 hover:bg-cream-200 dark:hover:bg-charcoal-600 transition-colors"
        >
          {dismissLabel}
        </button>
      </div>
    </div>
  );
}

function statusLabel(
  status: UploadJob['status'],
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  switch (status) {
    case 'pending':
    case 'creating':
      return t('upload.creatingSession');
    case 'uploading_chunks':
      return t('upload.uploadingAudio');
    case 'transcoding':
      return t('upload.transcoding');
    case 'uploading_to_soniox':
      return t('upload.uploadingToSoniox');
    case 'transcribing':
      return t('upload.transcribing');
    case 'finalizing':
      return t('upload.finalizing');
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ */
/*  刷新后的僵尸 session 找回                                            */
/* ------------------------------------------------------------------ */

/** localStorage 持久化的 job 里，按 sessionId 找一个匹配项。 */
function findJobBySession(sessionId: string): UploadJob | undefined {
  return Object.values(useUploadJobsStore.getState().jobs).find(
    (j) => j.sessionId === sessionId,
  );
}

/** 给一个服务端 session 新建占位 job（用于刷新后没有本地 job 的僵尸 session）。 */
function createJobForSession(server: ActiveAsyncJob, t: Translate): string {
  return uploadJobs.create({
    fileName: server.title || t('upload.untitledSession'),
    fileSize: 0,
    sessionId: server.id,
    sourceLang: '',
    targetLang: '',
    folderId: null,
  });
}

/**
 * 拉服务端"未收尾"的 async session，与本地持久化的 job 对账：
 *  - failed   → 确保失败区有一条带错误信息的 job
 *  - uploading_chunks → File 已丢，DELETE 清理服务端 + 标"上传中断"
 *  - 进行中    → 没有活跃 poll 的话重新挂 poll（poll 驱动服务端收尾）
 * 同时把本地持久化但服务端已不在列表里的进行中 job（多半已完成/被删）清掉，
 * 避免 widget 永远卡着一条假的进行中任务。
 */
async function reconcileOrphans(token: string, t: Translate): Promise<void> {
  let serverJobs: ActiveAsyncJob[];
  try {
    const res = await fetch('/api/sessions/active-async', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const body = (await res.json()) as { jobs?: ActiveAsyncJob[] };
    serverJobs = Array.isArray(body.jobs) ? body.jobs : [];
  } catch {
    return;
  }

  const serverIds = new Set(serverJobs.map((s) => s.id));

  // 清理本地"幽灵"进行中 job（本进程已无活跃 poll/pipeline）：
  //  - 有 sessionId 但服务端 active 列表里没有 —— 多半已完成或被删
  //  - 没 sessionId —— 刷新打断了 session 创建前的瞬态，无从恢复
  for (const job of Object.values(useUploadJobsStore.getState().jobs)) {
    if (
      ACTIVE_STATUSES.includes(job.status) &&
      !uploadJobs.hasCancel(job.id) &&
      (!job.sessionId || !serverIds.has(job.sessionId))
    ) {
      uploadJobs.remove(job.id);
    }
  }

  for (const server of serverJobs) {
    if (server.asyncTranscribeStatus === 'failed') {
      upsertFailedJob(
        server,
        server.asyncTranscribeError || t('upload.unknownError'),
        t,
      );
      continue;
    }

    if (server.asyncTranscribeStatus === 'uploading_chunks') {
      // 刷新后 File 句柄已丢，分片上传无法续传 —— 清服务端再标失败
      await fetch(`/api/sessions/${server.id}/async-upload`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
      upsertFailedJob(server, t('upload.interrupted'), t);
      continue;
    }

    if (SERVER_RUNNING_STATUSES.includes(server.asyncTranscribeStatus)) {
      reattachPoll(server, token, t);
    }
  }
}

/** 把一个 session 写成失败 job（已存在则就地更新，不存在则新建）。 */
function upsertFailedJob(
  server: ActiveAsyncJob,
  errorMessage: string,
  t: Translate,
): void {
  const existing = findJobBySession(server.id);
  if (existing) {
    uploadJobs.update(existing.id, { status: 'failed', errorMessage });
    uploadJobs.unregisterCancel(existing.id);
    return;
  }
  const id = createJobForSession(server, t);
  uploadJobs.update(id, { status: 'failed', errorMessage });
}

/**
 * 重新挂 poll：服务端 pipeline 的收尾步骤靠 client poll 驱动。
 * 已有活跃 poll（本进程内的 modal 还在跑）就跳过，避免重复 poll。
 */
function reattachPoll(server: ActiveAsyncJob, token: string, t: Translate): void {
  const existing = findJobBySession(server.id);
  if (existing && uploadJobs.hasCancel(existing.id)) return;

  const jobId = existing?.id ?? createJobForSession(server, t);

  uploadJobs.update(jobId, {
    sessionId: server.id,
    status: server.asyncTranscribeStatus as UploadJob['status'],
  });

  const abort = new AbortController();
  uploadJobs.registerCancel(jobId, async () => {
    abort.abort();
    await fetch(`/api/sessions/${server.id}/async-upload`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  });

  void pollAsyncTranscribeStatus(server.id, token, {
    signal: abort.signal,
    initialStatus: server.asyncTranscribeStatus as AsyncUploadStatus,
    onStatusChange: (status) =>
      uploadJobs.update(jobId, { status: status as UploadJob['status'] }),
    onProcessingProgress: (p) =>
      uploadJobs.update(jobId, { processingProgress: p }),
  })
    .then((result) => {
      uploadJobs.unregisterCancel(jobId);
      if (result.finalStatus === 'completed') {
        uploadJobs.update(jobId, { status: 'completed' });
      } else if (result.finalStatus === 'failed') {
        uploadJobs.update(jobId, {
          status: 'failed',
          errorMessage: result.error || t('upload.unknownError'),
        });
      } else if (result.finalStatus === 'canceled') {
        uploadJobs.update(jobId, { status: 'canceled' });
      }
    })
    .catch(() => {
      uploadJobs.unregisterCancel(jobId);
      uploadJobs.update(jobId, {
        status: 'failed',
        errorMessage: t('upload.unknownError'),
      });
    });
}
