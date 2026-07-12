'use client';

import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useI18n, type Locale } from '@/lib/i18n';
import NewSessionModal from '@/components/NewSessionModal';
import BackgroundTasksIndicator from '@/components/BackgroundTasksIndicator';
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

/* ───────── 时间段问候语系统（按语言切换） ─────────
   中文：应景古诗（poem）与轻松梗（fun）混排；英文：意境相近的短句。
   - 季节过滤：仅保留「当季 + all」，过滤后为空则回退该时段全部条目。
   - 季节优先：当季专属条目排在前面，all 条目随后（不丢任何条目）。
   - 逐日轮换：每个时段一天只出一条，逐日推进，保证一段时间内每条都能轮到。 */
type Season = 'spring' | 'summer' | 'autumn' | 'winter' | 'all';
type GreetingType = 'poem' | 'fun';

interface Greeting {
  type: GreetingType;
  season: Season;
  title: string;
  text: string;
  author: string | null;
}

const greetingsByLocale: Record<Locale, Record<string, Greeting[]>> = {
  zh: {
    // 6:00 - 11:59 晨
    morning: [
      { type: 'poem', season: 'spring', title: '晨光熹微', text: '春眠不觉晓，处处闻啼鸟。', author: '孟浩然' },
      { type: 'poem', season: 'all', title: '初日高林', text: '清晨入古寺，初日照高林。', author: '常建' },
      { type: 'poem', season: 'all', title: '朝辞彩云', text: '朝辞白帝彩云间，千里江陵一日还。', author: '李白' },
      { type: 'poem', season: 'spring', title: '黄鹂翠柳', text: '两个黄鹂鸣翠柳，一行白鹭上青天。', author: '杜甫' },
      { type: 'poem', season: 'all', title: '早行人', text: '莫道君行早，更有早行人。', author: '《增广贤文》' },
      { type: 'fun', season: 'all', title: '早八时刻', text: '早八人，早八魂。', author: null },
      { type: 'fun', season: 'all', title: '战胜被窝', text: '恭喜你战胜了被窝，这是今天的第一场胜利。', author: null },
      { type: 'fun', season: 'all', title: '咖啡时间', text: '咖啡因正在派送中，请稍候。', author: null },
      { type: 'fun', season: 'spring', title: '春晓修订版', text: '春眠不觉晓，早八迟到了。', author: '孟浩然（大概不会承认）' },
    ],
    // 12:00 - 13:59 午
    noon: [
      { type: 'poem', season: 'all', title: '日正当午', text: '锄禾日当午，汗滴禾下土。', author: '李绅' },
      { type: 'poem', season: 'all', title: '日高思茶', text: '酒困路长惟欲睡，日高人渴漫思茶。', author: '苏轼' },
      { type: 'poem', season: 'summer', title: '午睡初起', text: '日长睡起无情思，闲看儿童捉柳花。', author: '杨万里' },
      { type: 'poem', season: 'spring', title: '草堂春睡', text: '草堂春睡足，窗外日迟迟。', author: '《三国演义》' },
      { type: 'poem', season: 'summer', title: '绿树夏长', text: '绿树阴浓夏日长，楼台倒影入池塘。', author: '高骈' },
      { type: 'poem', season: 'summer', title: '蜻蜓蛱蝶', text: '日长篱落无人过，惟有蜻蜓蛱蝶飞。', author: '范成大' },
      { type: 'fun', season: 'all', title: '干饭时刻', text: '干饭人，干饭魂。', author: null },
      { type: 'fun', season: 'all', title: '民以食为天', text: '这句真是古人说的。', author: '《史记·郦生列传》' },
      { type: 'fun', season: 'all', title: '午休宣言', text: '午休神圣不可侵犯。', author: null },
    ],
    // 14:00 - 17:59 午后 · 斜阳
    afternoon: [
      { type: 'poem', season: 'autumn', title: '半江瑟瑟', text: '一道残阳铺水中，半江瑟瑟半江红。', author: '白居易' },
      { type: 'poem', season: 'autumn', title: '枫林晚照', text: '停车坐爱枫林晚，霜叶红于二月花。', author: '杜牧' },
      { type: 'poem', season: 'all', title: '人间晚晴', text: '天意怜幽草，人间重晚晴。', author: '李商隐' },
      { type: 'poem', season: 'autumn', title: '落霞孤鹜', text: '落霞与孤鹜齐飞，秋水共长天一色。', author: '王勃' },
      { type: 'poem', season: 'all', title: '飞鸟相还', text: '山气日夕佳，飞鸟相与还。', author: '陶渊明' },
      { type: 'fun', season: 'all', title: '生产力低谷', text: '下午三点：科学认证的生产力低谷。', author: null },
      { type: 'fun', season: 'all', title: '都记着呢', text: '走神了？没关系，字幕都帮你记着。', author: null },
      { type: 'fun', season: 'all', title: '眼皮下班', text: '眼皮正在申请提前下班。', author: null },
    ],
    // 18:00 - 21:59 暮
    evening: [
      { type: 'poem', season: 'autumn', title: '空山新雨', text: '空山新雨后，天气晚来秋。', author: '王维' },
      { type: 'poem', season: 'winter', title: '能饮一杯', text: '晚来天欲雪，能饮一杯无？', author: '白居易' },
      { type: 'poem', season: 'winter', title: '红泥火炉', text: '绿蚁新醅酒，红泥小火炉。', author: '白居易' },
      { type: 'poem', season: 'summer', title: '蛙声一片', text: '稻花香里说丰年，听取蛙声一片。', author: '辛弃疾' },
      { type: 'poem', season: 'spring', title: '夜静春山', text: '人闲桂花落，夜静春山空。', author: '王维' },
      { type: 'poem', season: 'all', title: '满河星', text: '微微风簇浪，散作满河星。', author: '查慎行' },
      { type: 'fun', season: 'all', title: '晚间补课', text: '白天没听懂的，晚上补回来。', author: null },
      { type: 'fun', season: 'all', title: '今夜不去pub', text: '别人在 pub，你在看 lecture。respect。', author: null },
      { type: 'fun', season: 'all', title: '晚上好', text: '吃了吗？没吃先去吃。', author: null },
    ],
    // 22:00 - 5:59 深夜
    night: [
      { type: 'poem', season: 'all', title: '床前明月', text: '床前明月光，疑是地上霜。', author: '李白' },
      { type: 'poem', season: 'all', title: '秉烛夜游', text: '昼短苦夜长，何不秉烛游。', author: '《古诗十九首》' },
      { type: 'poem', season: 'spring', title: '更深月色', text: '更深月色半人家，北斗阑干南斗斜。', author: '刘方平' },
      { type: 'poem', season: 'all', title: '三更灯火', text: '三更灯火五更鸡，正是男儿读书时。', author: '颜真卿' },
      { type: 'poem', season: 'all', title: '天涯共此时', text: '海上生明月，天涯共此时。', author: '张九龄' },
      { type: 'fun', season: 'all', title: '第一生产力', text: 'due 是第一生产力。', author: null },
      { type: 'fun', season: 'all', title: '服务器与你', text: '这个点还醒着的，除了你就是服务器。', author: null },
      { type: 'fun', season: 'all', title: '早点睡', text: '说真的，早点睡，lecture 明天还在。', author: null },
      { type: 'fun', season: 'all', title: '来得及', text: '现在去睡，一切都还来得及。', author: null },
    ],
  },
  en: {
    morning: [
      { type: 'poem', season: 'all', title: 'Good morning, early bird', text: 'The best ideas come with the morning light.', author: null },
      { type: 'poem', season: 'all', title: 'Dawn of discovery', text: 'Every lecture is a new adventure waiting to begin.', author: null },
      { type: 'poem', season: 'all', title: 'Sunrise scholar', text: 'The world is quiet — perfect time to focus.', author: null },
    ],
    noon: [
      { type: 'poem', season: 'all', title: 'Afternoon plus', text: 'Keep the momentum going through the midday sun.', author: null },
      { type: 'poem', season: 'all', title: 'Noon notes', text: 'Half the day down, twice the knowledge gained.', author: null },
      { type: 'poem', season: 'all', title: 'Midday mind', text: 'A quick review before the afternoon rush.', author: null },
    ],
    afternoon: [
      { type: 'poem', season: 'all', title: 'Golden hour study', text: 'The afternoon light pairs well with deep thinking.', author: null },
      { type: 'poem', season: 'all', title: 'Afternoon flow', text: 'You\'re in the zone — don\'t stop now.', author: null },
      { type: 'poem', season: 'all', title: 'Tea time transcripts', text: 'Sip, listen, and let the words flow.', author: null },
    ],
    evening: [
      { type: 'poem', season: 'all', title: 'Evening reflections', text: 'Review the day\'s discoveries while they\'re still warm.', author: null },
      { type: 'poem', season: 'all', title: 'Twilight thinker', text: 'The quiet evening is perfect for deep learning.', author: null },
      { type: 'poem', season: 'all', title: 'Moonlit studies', text: 'Let the calm of evening sharpen your focus.', author: null },
    ],
    night: [
      { type: 'poem', season: 'all', title: 'Night owl mode', text: 'The city sleeps, but your mind is wide awake.', author: null },
      { type: 'poem', season: 'all', title: 'Midnight scholar', text: 'Great minds work while the world dreams.', author: null },
      { type: 'poem', season: 'all', title: 'Stars & syllables', text: 'Under the night sky, every word counts more.', author: null },
    ],
  },
};

// 时段：[起, 止)，night 跨午夜（22–24 与 0–6 均算 night）
function getPeriod(hour: number): string {
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 14) return 'noon';
  if (hour >= 14 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 22) return 'evening';
  return 'night';
}

// 季节：3–5 spring、6–8 summer、9–11 autumn、12/1/2 winter
function getSeason(month: number): Season {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

function getGreeting(locale: Locale): Greeting {
  const now = new Date();
  const period = getPeriod(now.getHours());
  const season = getSeason(now.getMonth() + 1);

  const items = (greetingsByLocale[locale] ?? greetingsByLocale.en)[period] ?? [];

  // 季节过滤：保留「当季 + all」；过滤后为空则回退该时段全部条目
  const inSeason = items.filter((g) => g.season === season || g.season === 'all');
  const pool = inSeason.length > 0 ? inSeason : items;

  // 季节优先：当季专属条目排在前面，其余随后（组内保持原序，不丢任何条目）
  const ordered = [
    ...pool.filter((g) => g.season === season),
    ...pool.filter((g) => g.season !== season),
  ];

  // 逐日轮换：以距 1970 的天数为序号，每个时段一天只出一条，逐日推进保证每条都能轮到
  const dayIndex = Math.floor(now.getTime() / 86_400_000);
  return ordered[dayIndex % ordered.length];
}

// 渲染文案：author 非空 → 「text——author」，为 null → 仅 text（不出现空破折号）
function formatGreetingText(g: Greeting): string {
  return g.author ? `${g.text}——${g.author}` : g.text;
}

export default function HomePage() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const { t, locale } = useI18n();
  const { token, fetchQuotas } = useAuth();
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [stats, setStats] = useState<{ totalCount: number; totalDurationMs: number } | null>(null);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showNewSession, setShowNewSession] = useState(false);
  const [loading, setLoading] = useState(true);

  const listContainerRef = useRef<HTMLDivElement>(null);
  const [listLayout, setListLayout] = useState({ visibleCount: 100, paddingY: 14 });

  const greeting = useMemo(() => getGreeting(locale), [locale]);

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
        // 兼容分页响应格式 { items, nextCursor, totalCount, totalDurationMs } 和旧格式 []
        const data = sessionsResult.value;
        const items = Array.isArray(data) ? data : (data?.items ?? []);
        setSessions(items);
        if (!Array.isArray(data) && typeof data?.totalCount === 'number') {
          setStats({
            totalCount: data.totalCount,
            totalDurationMs: data.totalDurationMs ?? 0,
          });
        }
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
    if (min < 1) return locale === 'zh' ? '< 1 分钟' : '< 1 min';
    if (min >= 60) {
      const h = Math.floor(min / 60);
      const m = min % 60;
      if (locale === 'zh') return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    return locale === 'zh' ? `${min} 分钟` : `${min} min`;
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d
      .toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
      .toUpperCase();
  };

  const formatRelativeDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    // 用本地日历日期比较，避免跨天但不足24小时时判断错误
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return t('home.today');
    if (diffDays === 1) return t('home.yesterday');
    if (diffDays < 7) return t('home.daysAgo', { n: diffDays });
    return formatDate(dateStr);
  };

  // stats 已有则用服务端返回的总量，否则回退到已加载列表（首次加载时的空壳）
  const totalRecordingMs = stats
    ? stats.totalDurationMs
    : sessions.reduce((sum, s) => sum + getEffectiveDurationMs(s), 0);
  const totalSessionsCount = stats ? stats.totalCount : sessions.length;
  const totalRecordingMin = Math.floor(totalRecordingMs / 60000);
  const recordingTimeStr = totalRecordingMin < 60
    ? `${totalRecordingMin}m`
    : `${Math.floor(totalRecordingMin / 60)}h ${totalRecordingMin % 60}m`;

  const filteredSessions = sessions.filter((s) =>
    s.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  /* ───────── 动态列表布局：填满可用高度，智能挤压 ───────── */
  const recalcLayout = useCallback(() => {
    const el = listContainerRef.current;
    if (!el) return;
    const H = el.clientHeight;
    const N = filteredSessions.length;
    if (H <= 0 || N === 0) return;

    const CONTENT_H = isMobile ? 46 : 42;   // 每项内容区估算高度
    const DEFAULT_PY = isMobile ? 16 : 14;  // 默认纵向 padding
    const MIN_PY = isMobile ? 6 : 4;        // 最小挤压 padding
    const MAX_PY = isMobile ? 24 : 22;      // 最大拉伸 padding
    const SQUEEZE_RATIO = 0.35;              // 剩余 ≥ 35% 就尝试多塞一项

    const itemH = CONTENT_H + 2 * DEFAULT_PY;
    const fitCount = Math.floor(H / itemH);

    if (N <= fitCount) {
      // 条目全放得下，均分空间（cap 上限）
      const py = Math.min((H / N - CONTENT_H) / 2, MAX_PY);
      setListLayout({ visibleCount: N, paddingY: Math.max(py, MIN_PY) });
      return;
    }

    const leftover = H - fitCount * itemH;
    const ratio = leftover / itemH;

    if (ratio >= SQUEEZE_RATIO && fitCount > 0) {
      // 挤一挤多放一个
      const target = fitCount + 1;
      const py = (H / target - CONTENT_H) / 2;
      if (py >= MIN_PY) {
        setListLayout({ visibleCount: target, paddingY: py });
        return;
      }
    }

    // 均分给 fitCount 个
    if (fitCount > 0) {
      const py = Math.min((H / fitCount - CONTENT_H) / 2, MAX_PY);
      setListLayout({ visibleCount: fitCount, paddingY: Math.max(py, MIN_PY) });
    } else {
      setListLayout({ visibleCount: 1, paddingY: MIN_PY });
    }
  }, [filteredSessions.length, isMobile]);

  useEffect(() => {
    const el = listContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => recalcLayout());
    ro.observe(el);
    recalcLayout();
    return () => ro.disconnect();
  }, [recalcLayout]);

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
      <div className={`flex flex-col overflow-hidden ${isMobile ? 'h-[calc(100dvh-6rem)]' : 'h-[100dvh]'}`}>
        {/* 顶部区域：问候 + 搜索 */}
        <div className={`flex-shrink-0 ${isMobile ? 'px-4 pt-5 pb-2' : 'px-8 lg:px-12 pt-8 lg:pt-10 pb-2'}`}>
          {/* 问候语 + New Session 按钮 */}
          <div className={`mb-6 ${isMobile ? 'flex flex-col gap-4' : 'flex items-start justify-between'}`}>
            <div className="animate-fade-in-up">
              <div className="flex items-center gap-2 mb-1">
                <Sparkles className="w-5 h-5 text-rust-400" />
                <span className="text-xs font-medium text-rust-400 tracking-wider uppercase">
                  {new Date().toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                </span>
              </div>
              <h1 className="font-serif text-3xl lg:text-4xl font-bold text-charcoal-800 mb-1.5 tracking-tight">
                {greeting.title}
              </h1>
              <p className="text-charcoal-400 text-sm italic">
                {formatGreetingText(greeting)}
              </p>
            </div>

            {/* New Session 按钮 + 后台任务指示器 */}
            <div className={`flex items-center gap-2 ${isMobile ? 'w-full' : ''}`}>
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
                             isMobile ? 'flex-1 justify-center px-4 py-3' : 'px-5 py-3'
                           }`}
              >
                <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                  <Mic className="w-4 h-4" />
                </div>
                <div className="text-left">
                  <div className="text-sm font-semibold leading-tight">{t('home.newSession')}</div>
                  <div className="text-[10px] text-white/70">{t('home.startRecording')}</div>
                </div>
              </button>
              <BackgroundTasksIndicator />
            </div>
          </div>

          {/* 搜索栏 */}
          <div className="relative mb-4">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-charcoal-300" />
            <input
              type="text"
              placeholder={t('home.searchPlaceholder')}
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
              {t('home.recentSessions')}
            </h2>
            {filteredSessions.length > listLayout.visibleCount && (
              <Link
                href="/folders"
                className="text-xs font-medium text-rust-400 hover:text-rust-600 transition-colors"
              >
                {t('home.viewAll')} &rarr;
              </Link>
            )}
          </div>
          <div className="border-t border-cream-200/80 mt-2" />
        </div>

        {/* 中间可滚动的 Session 列表 */}
        <div ref={listContainerRef} className={`flex-1 min-h-0 overflow-hidden ${isMobile ? 'px-4' : 'px-8 lg:px-12'}`}>
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
              <p className="text-sm font-medium text-charcoal-500 mb-1">{t('home.noSessions')}</p>
              <p className="text-xs text-charcoal-400">
                {t('home.noSessionsDesc')}
              </p>
            </div>
          ) : (
            <div>
              {filteredSessions.slice(0, listLayout.visibleCount).map((s, index) => (
                <Link
                  key={s.id}
                  href={getSessionHref(s)}
                  className={`group flex items-center gap-4 rounded-xl
                             hover:bg-white hover:shadow-sm card-hover-lift
                             transition-all duration-200 ease-out
                             border border-transparent hover:border-cream-200
                             animate-list-item-in ${
                               isMobile ? 'px-4' : 'px-3 -mx-3'
                             }`}
                  style={{
                    paddingTop: `${listLayout.paddingY}px`,
                    paddingBottom: `${listLayout.paddingY}px`,
                    animationDelay: `${Math.min(index * 0.05, 0.5)}s`,
                  }}
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
                  {t('home.sessions')}
                </div>
                <div className="text-lg font-bold text-charcoal-800 leading-tight">
                  {totalSessionsCount}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 group/stat animate-count-up stagger-2">
              <div className="w-9 h-9 rounded-xl bg-rust-50 flex items-center justify-center group-hover/stat:bg-rust-100 transition-colors">
                <Clock className="w-4 h-4 text-rust-500" />
              </div>
              <div>
                <div className="text-[10px] font-medium text-charcoal-400 tracking-wider uppercase">
                  {t('home.recorded')}
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
                  {t('nav.folders')}
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
