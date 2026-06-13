'use client';

import {
  type ComponentType,
  type SVGProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import {
  Activity,
  ChevronRight,
  FileText,
  Hash,
  Loader2,
  Mic,
  Sparkles,
  Tag,
  Upload,
  X,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useExitAnimation } from '@/hooks/useExitAnimation';
import { useI18n } from '@/lib/i18n';

interface JobItem {
  id: string;
  type: string;
  status: string;
  sessionId: string | null;
  sessionTitle?: string | null;
  createdAt: string;
  startedAt: string | null;
}

interface FinalizingSession {
  id: string;
  title: string;
  status: string;
  createdAt: string;
}

interface AsyncSession {
  id: string;
  title: string;
  asyncTranscribeStatus: string | null;
  createdAt: string;
}

interface BackgroundTasksResponse {
  jobs: JobItem[];
  finalizingSessions: FinalizingSession[];
  asyncTranscribingSessions: AsyncSession[];
  hasActiveTasks: boolean;
  totalCount: number;
}

const POLL_ACTIVE_MS = 10_000;
const POLL_IDLE_MS = 30_000;
const RUNNING_FOR_TICK_MS = 30_000;

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

const JOB_TYPE_ICON: Record<string, IconType> = {
  report_generation: FileText,
  title_generation: Tag,
  keyword_extraction: Hash,
};

const ASYNC_STATUS_ICON: Record<string, IconType> = {
  uploading_chunks: Upload,
  uploading_to_soniox: Upload,
  transcoding: Mic,
  transcribing: Mic,
  finalizing: Loader2,
};

// 用稳定签名跳过 no-op setData，避免每次轮询都触发全树重渲染
function signatureFor(body: BackgroundTasksResponse): string {
  return [
    body.totalCount,
    body.jobs.map((j) => `${j.id}:${j.status}`).join(','),
    body.finalizingSessions.map((s) => s.id).join(','),
    body.asyncTranscribingSessions.map((s) => `${s.id}:${s.asyncTranscribeStatus ?? ''}`).join(','),
  ].join('|');
}

interface TaskRowProps {
  href?: string;
  icon: IconType;
  spinIcon?: boolean;
  primary: string;
  secondary: string;
  onNavigate: () => void;
}

function TaskRow({ href, icon: Icon, spinIcon, primary, secondary, onNavigate }: TaskRowProps) {
  const body = (
    <span className="flex w-full items-center gap-2.5">
      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-600">
        <Icon className={`h-3.5 w-3.5 ${spinIcon ? 'animate-spin' : ''}`} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-charcoal-800">{primary}</span>
        <span className="block truncate text-[11px] text-charcoal-500">{secondary}</span>
      </span>
      {href && (
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-charcoal-300 group-hover:text-charcoal-500" />
      )}
    </span>
  );

  if (href) {
    return (
      <Link
        href={href}
        onClick={onNavigate}
        className="group flex items-center rounded-lg px-2 py-2 transition-colors hover:bg-cream-50"
      >
        {body}
      </Link>
    );
  }
  return <div className="flex items-center rounded-lg px-2 py-2">{body}</div>;
}

export default function BackgroundTasksIndicator() {
  const { t, locale } = useI18n();
  const token = useAuthStore((s) => s.token);
  const [data, setData] = useState<BackgroundTasksResponse | null>(null);
  const [open, setOpen] = useState(false);
  const { mounted: popoverMounted, leaving: popoverLeaving } = useExitAnimation(open, 150);
  const [now, setNow] = useState(() => Date.now());
  const containerRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const lastSignatureRef = useRef<string>('');
  const hasActiveRef = useRef(false);

  const fetchTasks = useCallback(async () => {
    const currentToken = tokenRef.current;
    if (!currentToken) return;
    try {
      const res = await fetch('/api/user/background-tasks', {
        headers: { Authorization: `Bearer ${currentToken}` },
        cache: 'no-store',
      });
      if (!res.ok) return;
      const body = (await res.json()) as BackgroundTasksResponse;
      const sig = signatureFor(body);
      hasActiveRef.current = body.hasActiveTasks && body.totalCount > 0;
      if (sig === lastSignatureRef.current) return;
      lastSignatureRef.current = sig;
      setData(body);
    } catch {
      // 静默：轮询失败不打扰用户
    }
  }, []);

  // 轮询：可见时按节奏拉，不可见时跳过这一轮；下次可见立即拉一次
  useEffect(() => {
    if (!token) {
      setData(null);
      lastSignatureRef.current = '';
      hasActiveRef.current = false;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const schedule = (delay: number) => {
      if (stopped) return;
      timer = setTimeout(loop, delay);
    };

    const loop = async () => {
      if (typeof document !== 'undefined' && document.hidden) {
        schedule(POLL_IDLE_MS);
        return;
      }
      await fetchTasks();
      schedule(hasActiveRef.current ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };

    void fetchTasks().then(() => {
      schedule(hasActiveRef.current ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    });

    const onVisibility = () => {
      if (!document.hidden) void fetchTasks();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [token, fetchTasks]);

  // popover 打开时才更新 "已运行 X" — 关着没人看，省掉一个全局 interval
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), RUNNING_FOR_TICK_MS);
    return () => clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const totalCount = data?.totalCount ?? 0;
  const hasActive = (data?.hasActiveTasks ?? false) && totalCount > 0;

  const formatRunningFor = useMemo(() => {
    const zh = locale === 'zh';
    return (startIso: string) => {
      const startedMs = new Date(startIso).getTime();
      if (Number.isNaN(startedMs)) return '';
      const sec = Math.max(0, Math.floor((now - startedMs) / 1000));
      if (sec < 60) return zh ? `${sec} 秒` : `${sec}s`;
      const min = Math.floor(sec / 60);
      if (min < 60) return zh ? `${min} 分钟` : `${min} min`;
      const hr = Math.floor(min / 60);
      const rem = min % 60;
      if (rem === 0) return zh ? `${hr} 小时` : `${hr}h`;
      return zh ? `${hr} 小时 ${rem} 分钟` : `${hr}h ${rem}m`;
    };
  }, [now, locale]);

  const labelForJobType = useCallback(
    (type: string) => {
      const translated = t(`backgroundTasks.types.${type}`);
      return translated.startsWith('backgroundTasks.types.') ? type : translated;
    },
    [t],
  );

  const labelForAsyncStatus = useCallback(
    (status: string | null) => {
      if (!status) return t('backgroundTasks.types.transcribing');
      const translated = t(`backgroundTasks.types.${status}`);
      return translated.startsWith('backgroundTasks.types.') ? status : translated;
    },
    [t],
  );

  if (!token) return null;
  if (!hasActive) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('backgroundTasks.title')}
        aria-expanded={open}
        title={t('backgroundTasks.title')}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-xl
                   border border-amber-300/60 bg-amber-50 text-amber-600
                   shadow-sm shadow-amber-200/50 transition-all duration-200
                   hover:bg-amber-100 active:scale-[0.95]"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        <span
          className="absolute -top-1 -right-1 inline-flex h-4 min-w-[16px] items-center justify-center
                     rounded-full bg-rust-500 px-1 text-[10px] font-semibold leading-none text-white
                     shadow-sm ring-1 ring-white"
        >
          {totalCount > 99 ? '99+' : totalCount}
        </span>
      </button>

      {popoverMounted && (
        <div
          role="dialog"
          aria-label={t('backgroundTasks.title')}
          className={`absolute right-0 top-full z-50 mt-1.5 w-80 origin-top-right
                     ${
                       popoverLeaving
                         ? 'animate-[popoverOut_0.15s_ease-in_forwards]'
                         : 'animate-[popoverIn_0.18s_ease-out]'
                     } rounded-xl border border-cream-300
                     bg-white p-4 shadow-xl`}
        >
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-charcoal-800">
              <Activity className="h-4 w-4 text-amber-500" />
              {t('backgroundTasks.title')}
            </h3>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-charcoal-400 hover:text-charcoal-600"
              aria-label={t('common.close')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <ul className="max-h-[60vh] space-y-1.5 overflow-y-auto">
            {data?.asyncTranscribingSessions.map((s) => (
              <li key={`async-${s.id}`}>
                <TaskRow
                  href={`/session/${s.id}`}
                  onNavigate={() => setOpen(false)}
                  icon={ASYNC_STATUS_ICON[s.asyncTranscribeStatus ?? ''] ?? Loader2}
                  spinIcon
                  primary={s.title}
                  secondary={`${labelForAsyncStatus(s.asyncTranscribeStatus)} · ${t(
                    'backgroundTasks.runningFor',
                    { time: formatRunningFor(s.createdAt) },
                  )}`}
                />
              </li>
            ))}

            {data?.finalizingSessions.map((s) => (
              <li key={`final-${s.id}`}>
                <TaskRow
                  href={`/session/${s.id}`}
                  onNavigate={() => setOpen(false)}
                  icon={Loader2}
                  spinIcon
                  primary={s.title}
                  secondary={`${t('backgroundTasks.types.finalizing')} · ${t(
                    'backgroundTasks.runningFor',
                    { time: formatRunningFor(s.createdAt) },
                  )}`}
                />
              </li>
            ))}

            {data?.jobs.map((j) => {
              const typeLabel = labelForJobType(j.type);
              return (
                <li key={`job-${j.id}`}>
                  <TaskRow
                    href={j.sessionId ? `/session/${j.sessionId}` : undefined}
                    onNavigate={() => setOpen(false)}
                    icon={JOB_TYPE_ICON[j.type] ?? Sparkles}
                    primary={j.sessionTitle ?? typeLabel}
                    secondary={`${typeLabel} · ${t('backgroundTasks.runningFor', {
                      time: formatRunningFor(j.startedAt ?? j.createdAt),
                    })}`}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
