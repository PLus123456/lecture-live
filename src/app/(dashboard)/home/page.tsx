'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/useIsMobile';
import NewSessionModal from '@/components/NewSessionModal';
import {
  Mic,
  Search,
  ArrowRight,
  FileText,
  Clock,
  FolderOpen,
  BarChart3,
  Sparkles,
} from 'lucide-react';

interface SessionItem {
  id: string;
  title: string;
  createdAt: string;
  durationMs: number;
  sourceLang: string;
  targetLang: string;
  status: string;
  courseName?: string;
  serverStartedAt?: string | null;
  serverPausedMs?: number;
  serverPausedAt?: string | null;
  folders?: { folder: { id: string; name: string } }[];
}

interface FolderItem {
  id: string;
}

/* ───────── 时间段问候语系统 ───────── */
interface Greeting {
  title: string;
  subtitle: string;
}

const greetings: Record<string, Greeting[]> = {
  // 6:00 - 11:59
  morning: [
    { title: 'Good morning, early bird', subtitle: 'The best ideas come with the morning light.' },
    { title: 'Rise and learn', subtitle: 'A fresh day, a fresh page of notes.' },
    { title: 'Morning momentum', subtitle: 'Start capturing knowledge while the mind is sharp.' },
    { title: 'Dawn of discovery', subtitle: 'Every lecture is a new adventure waiting to begin.' },
    { title: 'Sunrise scholar', subtitle: 'The world is quiet — perfect time to focus.' },
  ],
  // 12:00 - 13:59
  midday: [
    { title: 'Afternoon plus', subtitle: 'Keep the momentum going through the midday sun.' },
    { title: 'Lunch break learner', subtitle: 'Fuel the body, feed the mind.' },
    { title: 'Noon notes', subtitle: 'Half the day down, twice the knowledge gained.' },
    { title: 'Midday mind', subtitle: 'A quick review before the afternoon rush.' },
  ],
  // 14:00 - 17:59
  afternoon: [
    { title: 'Golden hour study', subtitle: 'The afternoon light pairs well with deep thinking.' },
    { title: 'Afternoon flow', subtitle: 'You\'re in the zone — don\'t stop now.' },
    { title: 'Late day scholar', subtitle: 'The best conversations happen after 2 PM.' },
    { title: 'Sunset prep', subtitle: 'Capture today\'s lessons before the day fades.' },
    { title: 'Tea time transcripts', subtitle: 'Sip, listen, and let the words flow.' },
  ],
  // 18:00 - 21:59
  evening: [
    { title: 'Evening reflections', subtitle: 'Review the day\'s discoveries while they\'re still warm.' },
    { title: 'Twilight thinker', subtitle: 'The quiet evening is perfect for deep learning.' },
    { title: 'Night school vibes', subtitle: 'Some of the best insights come after dark.' },
    { title: 'Moonlit studies', subtitle: 'Let the calm of evening sharpen your focus.' },
    { title: 'Dusk & documents', subtitle: 'Wind down the day, but keep the curiosity alive.' },
  ],
  // 22:00 - 5:59
  lateNight: [
    { title: 'Night owl mode', subtitle: 'The city sleeps, but your mind is wide awake.' },
    { title: 'Midnight scholar', subtitle: 'Great minds work while the world dreams.' },
    { title: 'Burning the midnight oil', subtitle: 'Dedication has no curfew.' },
    { title: 'After hours genius', subtitle: 'Silence is the best classroom.' },
    { title: 'Stars & syllables', subtitle: 'Under the night sky, every word counts more.' },
    { title: 'Nocturnal notes', subtitle: 'The late-night study hits different.' },
  ],
};

function getGreeting(): Greeting {
  const hour = new Date().getHours();
  let period: string;
  if (hour >= 6 && hour < 12) period = 'morning';
  else if (hour >= 12 && hour < 14) period = 'midday';
  else if (hour >= 14 && hour < 18) period = 'afternoon';
  else if (hour >= 18 && hour < 22) period = 'evening';
  else period = 'lateNight';

  const pool = greetings[period];
  // 使用日期 + 小时作为伪随机种子，每小时变一次
  const seed = new Date().getDate() * 24 + hour;
  return pool[seed % pool.length];
}

export default function HomePage() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const { token, fetchQuotas } = useAuth();
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showNewSession, setShowNewSession] = useState(false);
  const [loading, setLoading] = useState(true);

  const greeting = useMemo(() => getGreeting(), []);

  useEffect(() => {
    if (!token) return;
    setLoading(true);

    // 并行请求，用 Promise.allSettled 避免一个失败阻塞另一个
    // 首页仅加载最近 50 个会话，足够展示且大幅减少响应时间
    Promise.allSettled([
      fetch('/api/sessions?limit=50', {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json()),
      fetch('/api/folders', {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json()),
      fetchQuotas(),
    ]).then(([sessionsResult, foldersResult]) => {
      if (sessionsResult.status === 'fulfilled') {
        // 兼容分页响应格式 { items, nextCursor } 和旧格式 []
        const data = sessionsResult.value;
        const items = Array.isArray(data) ? data : (data?.items ?? []);
        setSessions(items);
      }
      if (foldersResult.status === 'fulfilled' && Array.isArray(foldersResult.value)) {
        setFolders(foldersResult.value);
      }
      setLoading(false);
    });
  }, [token, fetchQuotas]);

  // 计算 session 的实际录音时长（对未完成的 session 用服务端时间戳实时算）
  const getEffectiveDurationMs = (s: SessionItem) => {
    if (s.durationMs > 0) return s.durationMs;
    // 未 finalize 的 session，durationMs 为 0，需要从 serverStartedAt 实时计算
    if (!s.serverStartedAt) return 0;
    const startedAt = new Date(s.serverStartedAt).getTime();
    const pausedMs = s.serverPausedMs ?? 0;
    const pendingPausedMs = s.serverPausedAt
      ? Math.max(0, Date.now() - new Date(s.serverPausedAt).getTime())
      : 0;
    return Math.max(0, Date.now() - startedAt - pausedMs - pendingPausedMs);
  };

  const formatDuration = (ms: number) => {
    const min = Math.floor(ms / 60000);
    if (min < 1) return '< 1 min';
    if (min >= 60) {
      const h = Math.floor(min / 60);
      const m = min % 60;
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    return `${min} min`;
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).toUpperCase();
  };

  const formatRelativeDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    // 用本地日历日期比较，避免跨天但不足24小时时判断错误
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return formatDate(dateStr);
  };

  const totalRecordingMs = sessions.reduce((sum, s) => sum + getEffectiveDurationMs(s), 0);
  const totalRecordingMin = Math.floor(totalRecordingMs / 60000);
  const recordingTimeStr = totalRecordingMin < 60
    ? `${totalRecordingMin}m`
    : `${Math.floor(totalRecordingMin / 60)}h ${totalRecordingMin % 60}m`;

  const filteredSessions = sessions.filter((s) =>
    s.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getSessionHref = (session: SessionItem) =>
    ['COMPLETED', 'ARCHIVED'].includes(session.status)
      ? `/session/${session.id}/playback`
      : `/session/${session.id}`;

  // 状态颜色映射
  const getStatusDot = (status: string) => {
    switch (status) {
      case 'RECORDING':
      case 'PAUSED':
        return 'bg-green-400 animate-pulse';
      case 'COMPLETED':
        return 'bg-rust-400';
      case 'ARCHIVED':
        return 'bg-charcoal-300';
      default:
        return 'bg-cream-400';
    }
  };

  return (
    <>
      <div className="flex min-h-screen flex-col overflow-hidden">
        {/* 顶部区域：问候 + 搜索 */}
        <div className={`flex-shrink-0 ${isMobile ? 'px-4 pt-5 pb-2' : 'px-8 lg:px-12 pt-8 lg:pt-10 pb-2'}`}>
          {/* 问候语 + New Session 按钮 */}
          <div className={`mb-6 ${isMobile ? 'flex flex-col gap-4' : 'flex items-start justify-between'}`}>
            <div className="animate-fade-in-up">
              <div className="flex items-center gap-2 mb-1">
                <Sparkles className="w-5 h-5 text-rust-400" />
                <span className="text-xs font-medium text-rust-400 tracking-wider uppercase">
                  {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                </span>
              </div>
              <h1 className="font-serif text-3xl lg:text-4xl font-bold text-charcoal-800 mb-1.5 tracking-tight">
                {greeting.title}
              </h1>
              <p className="text-charcoal-400 text-sm italic">
                {greeting.subtitle}
              </p>
            </div>

            {/* New Session 按钮 */}
            <button
              onClick={() => {
                if (isMobile) {
                  router.push('/session/new');
                  return;
                }
                setShowNewSession(true);
              }}
              className={`group/btn relative flex items-center gap-2.5
                         bg-gradient-to-r from-rust-500 to-rust-600 text-white rounded-xl
                         hover:from-rust-600 hover:to-rust-700 active:scale-[0.97]
                         transition-all duration-200
                         shadow-lg shadow-rust-500/20 hover:shadow-xl hover:shadow-rust-500/30
                         animate-fade-in-up stagger-2 ${
                           isMobile ? 'w-full justify-center px-4 py-3' : 'px-5 py-3'
                         }`}
            >
              <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                <Mic className="w-4 h-4" />
              </div>
              <div className="text-left">
                <div className="text-sm font-semibold leading-tight">New Session</div>
                <div className="text-[10px] text-white/70">Start recording</div>
              </div>
            </button>
          </div>

          {/* 搜索栏 */}
          <div className="relative mb-4">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-charcoal-300" />
            <input
              type="text"
              placeholder="Search sessions, courses, or notes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-11 pr-4 py-2.5 rounded-xl border border-cream-300 bg-white/80 backdrop-blur-sm
                         text-sm text-charcoal-700 placeholder:text-charcoal-300
                         focus:outline-none focus:border-rust-300 focus:ring-2 focus:ring-rust-100
                         transition-all duration-200"
            />
          </div>

          {/* Sessions 标题 */}
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-charcoal-400 tracking-wider uppercase">
              Recent Sessions
            </h2>
            {sessions.length > 3 && (
              <Link
                href="/folders"
                className="text-xs font-medium text-rust-400 hover:text-rust-600 transition-colors"
              >
                View all &rarr;
              </Link>
            )}
          </div>
          <div className="border-t border-cream-200/80 mt-2" />
        </div>

        {/* 中间可滚动的 Session 列表 */}
        <div className={`flex-1 min-h-0 overflow-y-auto scrollbar-thin ${isMobile ? 'px-4 pb-28' : 'px-8 lg:px-12'}`}>
          {loading ? (
            /* 加载骨架屏 */
            <div className="py-1 animate-pulse space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex items-center gap-4 py-3.5 px-3">
                  <div className="w-2 h-2 rounded-full bg-cream-300" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-cream-200 rounded w-1/3" />
                    <div className="h-3 bg-cream-100 rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-12 animate-fade-in-up">
              <div className="w-16 h-16 rounded-2xl bg-cream-200/50 flex items-center justify-center mb-4 animate-breathe">
                <FileText className="w-7 h-7 text-charcoal-300" />
              </div>
              <p className="text-sm font-medium text-charcoal-500 mb-1">No sessions yet</p>
              <p className="text-xs text-charcoal-400">
                Start a new recording to see your sessions here
              </p>
            </div>
          ) : (
            <div className="py-1">
              {filteredSessions.map((s, index) => (
                <Link
                  key={s.id}
                  href={getSessionHref(s)}
                  className={`group flex items-center gap-4 rounded-xl
                             hover:bg-white hover:shadow-sm card-hover-lift
                             transition-all duration-200 ease-out
                             border border-transparent hover:border-cream-200
                             animate-list-item-in ${
                               isMobile ? 'min-h-[72px] px-4 py-4' : 'py-3.5 px-3 -mx-3'
                             }`}
                  style={{ animationDelay: `${Math.min(index * 0.05, 0.5)}s` }}
                >
                  {/* 状态指示点 */}
                  <div className="flex-shrink-0 flex flex-col items-center gap-1">
                    <div className={`w-2 h-2 rounded-full ${getStatusDot(s.status)}`} />
                  </div>

                  {/* 主要内容 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={`${isMobile ? 'text-base' : 'text-sm'} font-semibold text-charcoal-800 group-hover:text-rust-600 transition-colors truncate`}>
                        {s.title}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-charcoal-400">
                      <span>{formatRelativeDate(s.createdAt)}</span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDuration(getEffectiveDurationMs(s))}
                      </span>
                      {s.folders && s.folders.length > 0 && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-cream-100 border border-cream-200 text-charcoal-500 text-[10px] uppercase tracking-wide">
                          <FolderOpen className="w-2.5 h-2.5" />
                          {s.folders[0].folder.name}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 箭头 */}
                  <ArrowRight className="w-4 h-4 text-charcoal-300 group-hover:text-rust-500 group-hover:translate-x-0.5 transition-all duration-200 flex-shrink-0" />
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* 底部统计栏 — 永远显示 */}
        <div className={`flex-shrink-0 border-t border-cream-200/80 bg-white/50 backdrop-blur-sm ${isMobile ? 'px-4 py-3' : 'px-8 lg:px-12 py-4'}`}>
          <div className={`${isMobile ? 'flex items-center justify-between gap-3' : 'grid grid-cols-3 gap-4'}`}>
            <div className="flex items-center gap-3 group/stat animate-count-up stagger-1">
              <div className="w-9 h-9 rounded-xl bg-rust-50 flex items-center justify-center group-hover/stat:bg-rust-100 transition-colors">
                <BarChart3 className="w-4 h-4 text-rust-500" />
              </div>
              <div>
                <div className="text-[10px] font-medium text-charcoal-400 tracking-wider uppercase">
                  Sessions
                </div>
                <div className="text-lg font-bold text-charcoal-800 leading-tight">
                  {sessions.length}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 group/stat animate-count-up stagger-2">
              <div className="w-9 h-9 rounded-xl bg-rust-50 flex items-center justify-center group-hover/stat:bg-rust-100 transition-colors">
                <Clock className="w-4 h-4 text-rust-500" />
              </div>
              <div>
                <div className="text-[10px] font-medium text-charcoal-400 tracking-wider uppercase">
                  Recorded
                </div>
                <div className="text-lg font-bold text-charcoal-800 leading-tight">
                  {recordingTimeStr}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 group/stat animate-count-up stagger-3">
              <div className="w-9 h-9 rounded-xl bg-rust-50 flex items-center justify-center group-hover/stat:bg-rust-100 transition-colors">
                <FolderOpen className="w-4 h-4 text-rust-500" />
              </div>
              <div>
                <div className="text-[10px] font-medium text-charcoal-400 tracking-wider uppercase">
                  Folders
                </div>
                <div className="text-lg font-bold text-charcoal-800 leading-tight">
                  {folders.length}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {!isMobile && showNewSession && (
        <NewSessionModal
          onClose={() => setShowNewSession(false)}
        />
      )}
    </>
  );
}
