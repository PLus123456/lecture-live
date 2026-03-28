'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Users, Mic, Share2, FolderOpen } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';

interface DailyStats {
  date: string;
  newUsers: number;
  recordings: number;
  shares: number;
}

interface StatsData {
  totals: { users: number; sessions: number; shares: number; folders: number };
  daily: DailyStats[];
}

// ──── Combined Trend Chart (Cloudreve style) ────

// Warm palette matching cream/charcoal/rust theme
const SERIES = [
  { key: 'newUsers' as const, label: 'Users', color: '#7c9ac7' },   // muted steel-blue
  { key: 'recordings' as const, label: 'Files', color: '#c2864a' }, // warm amber-rust
  { key: 'shares' as const, label: 'Shares', color: '#7dab8a' },    // sage green
];

// Monotone cubic Hermite interpolation — guarantees no overshoot (values stay within data range)
function monotonePath(
  pts: { x: number; y: number }[],
  yMin: number,
  yMax: number,
): string {
  const n = pts.length;
  if (n < 2) return '';
  if (n === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;

  // 1. Compute slopes between consecutive points
  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = []; // secant slopes
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x);
    dy.push(pts[i + 1].y - pts[i].y);
    m.push(dx[i] === 0 ? 0 : dy[i] / dx[i]);
  }

  // 2. Compute tangent slopes with Fritsch-Carlson monotonicity
  const tangent: number[] = new Array(n);
  tangent[0] = m[0];
  tangent[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      // local extremum → flat tangent (prevents overshoot)
      tangent[i] = 0;
    } else {
      tangent[i] = (m[i - 1] + m[i]) / 2;
    }
  }

  // 3. Fritsch-Carlson step 2: restrict tangent magnitudes
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(m[i]) < 1e-10) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
    } else {
      const alpha = tangent[i] / m[i];
      const beta = tangent[i + 1] / m[i];
      const s = alpha * alpha + beta * beta;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        tangent[i] = t * alpha * m[i];
        tangent[i + 1] = t * beta * m[i];
      }
    }
  }

  // 4. Build cubic Bezier segments with Y clamping
  const clampY = (y: number) => Math.max(yMax, Math.min(yMin, y)); // note: SVG y is inverted
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const seg = dx[i] / 3;
    const cp1x = pts[i].x + seg;
    const cp1y = clampY(pts[i].y + tangent[i] * seg);
    const cp2x = pts[i + 1].x - seg;
    const cp2y = clampY(pts[i + 1].y - tangent[i + 1] * seg);
    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${pts[i + 1].x},${pts[i + 1].y}`;
  }
  return d;
}

function CombinedTrendChart({ data }: { data: DailyStats[] }) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  // animKey 变化时强制重新挂载动画组，确保每次进入都从头播放
  const [animKey, setAnimKey] = useState(0);
  const [animDone, setAnimDone] = useState(false);
  const [tooltip, setTooltip] = useState<{
    visible: boolean;
    x: number;
    index: number;
  }>({ visible: false, x: 0, index: 0 });

  // 数据到达后重置动画
  useEffect(() => {
    if (!data.length) return;
    setAnimDone(false);
    setAnimKey((k) => k + 1);
    const timer = setTimeout(() => setAnimDone(true), 1500);
    return () => clearTimeout(timer);
  }, [data]);

  if (!data.length) {
    return (
      <div className="flex items-center justify-center text-charcoal-400 text-sm h-[320px]">
        {t('common.noData')}
      </div>
    );
  }

  // Chart dimensions
  const W = 800;
  const H = 320;
  const padL = 40;
  const padR = 16;
  const padT = 16;
  const padB = 32;

  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  // Y axis scale
  const allValues = data.flatMap((d) => [d.newUsers, d.recordings, d.shares]);
  const maxVal = Math.max(...allValues, 1);
  const niceMax = Math.ceil(maxVal / (maxVal <= 5 ? 1 : maxVal <= 20 ? 5 : 10)) *
    (maxVal <= 5 ? 1 : maxVal <= 20 ? 5 : 10);
  const yTicks: number[] = [];
  const yStep = niceMax <= 5 ? 1 : niceMax / 4;
  for (let v = 0; v <= niceMax; v += yStep) yTicks.push(Math.round(v));

  // X axis label interval
  const xLabelStep = Math.max(1, Math.floor(data.length / 10));

  // Coordinate transforms
  const toX = (i: number) => padL + (i / Math.max(1, data.length - 1)) * chartW;
  const toY = (v: number) => padT + chartH - (v / niceMax) * chartH;
  const yFloor = toY(0);   // SVG y for value 0 (bottom)
  const yCeil = toY(niceMax); // SVG y for max value (top)

  // Series points
  const seriesPoints = SERIES.map((s) =>
    data.map((d, i) => ({ x: toX(i), y: toY(d[s.key] as number) })),
  );

  // Build monotone paths (clamped to chart bounds)
  const seriesPaths = seriesPoints.map((pts) =>
    monotonePath(pts, yFloor, yCeil),
  );

  // Mouse hover handler
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    let closest = 0;
    let minDist = Infinity;
    for (let i = 0; i < data.length; i++) {
      const dist = Math.abs(toX(i) - svgX);
      if (dist < minDist) {
        minDist = dist;
        closest = i;
      }
    }

    setTooltip({ visible: true, x: toX(closest), index: closest });
  };

  const handleMouseLeave = () => {
    setTooltip((prev) => ({ ...prev, visible: false }));
  };

  const tipData = data[tooltip.index];

  return (
    <div ref={containerRef} className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: 320 }}
        preserveAspectRatio="xMidYMid meet"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {/* Horizontal dashed grid */}
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={padL}
              y1={toY(v)}
              x2={W - padR}
              y2={toY(v)}
              stroke="#e8e2d9"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <text x={padL - 8} y={toY(v) + 4} textAnchor="end" fontSize={11} fill="#b0a89e">
              {v}
            </text>
          </g>
        ))}

        {/* Vertical dashed grid */}
        {data.map((_, i) =>
          i % xLabelStep === 0 ? (
            <line
              key={`vg-${i}`}
              x1={toX(i)}
              y1={padT}
              x2={toX(i)}
              y2={padT + chartH}
              stroke="#e8e2d9"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
          ) : null,
        )}

        {/* 定义从左到右的裁剪动画 */}
        <defs>
          <clipPath id={`reveal-${animKey}`}>
            <rect x={0} y={0} width={W} height={H}>
              <animate
                attributeName="width"
                from="0"
                to={W}
                dur="1.4s"
                fill="freeze"
                calcMode="spline"
                keySplines="0.25 0.1 0.25 1"
                keyTimes="0;1"
                begin="0s"
              />
            </rect>
          </clipPath>
        </defs>

        {/* 线条 + 圆点在同一个 clip 组内，线到哪、点出到哪 */}
        <g key={animKey} clipPath={`url(#reveal-${animKey})`}>
          {/* 三条平滑曲线 */}
          {SERIES.map((s, si) => (
            <path
              key={s.key}
              d={seriesPaths[si]}
              fill="none"
              stroke={s.color}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {/* 数据点圆点 — 与线同步出现 */}
          {SERIES.map((s, si) =>
            seriesPoints[si].map((p, pi) => (
              <circle
                key={`${s.key}-${pi}`}
                cx={p.x}
                cy={p.y}
                r={3}
                fill="white"
                stroke={s.color}
                strokeWidth={2}
              />
            )),
          )}
        </g>

        {/* X axis date labels */}
        {data.map((d, i) =>
          i % xLabelStep === 0 ? (
            <text
              key={`xl-${i}`}
              x={toX(i)}
              y={H - 6}
              textAnchor="middle"
              fontSize={11}
              fill="#b0a89e"
            >
              {d.date.slice(5)}
            </text>
          ) : null,
        )}

        {/* Hover vertical line (only after animation done) */}
        {animDone && tooltip.visible && (
          <line
            x1={tooltip.x}
            y1={padT}
            x2={tooltip.x}
            y2={padT + chartH}
            stroke="#c4b9ac"
            strokeWidth={1}
            strokeDasharray="4 2"
          />
        )}

        {/* Hover highlight dots */}
        {animDone && tooltip.visible &&
          SERIES.map((s, si) => (
            <circle
              key={`hl-${s.key}`}
              cx={seriesPoints[si][tooltip.index].x}
              cy={seriesPoints[si][tooltip.index].y}
              r={5}
              fill={s.color}
              stroke="white"
              strokeWidth={2}
            />
          ))}
      </svg>

      {/* Bottom legend */}
      <div className="flex items-center justify-center gap-6 mt-2">
        {SERIES.map((s) => (
          <div key={s.key} className="flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-full inline-block"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-xs text-charcoal-500">{s.label}</span>
          </div>
        ))}
      </div>

      {/* Floating Tooltip (only after animation) */}
      {animDone && tooltip.visible && tipData && (
        <div
          className="absolute pointer-events-none bg-white/95 backdrop-blur-sm border border-cream-200 rounded-lg shadow-lg px-4 py-3 z-10"
          style={{
            left: `${(tooltip.x / W) * 100}%`,
            top: 16,
            transform: tooltip.x > W * 0.7 ? 'translateX(-110%)' : 'translateX(10px)',
          }}
        >
          <div className="text-sm font-semibold text-charcoal-700 mb-1.5 border-b border-cream-100 pb-1.5">
            {tipData.date.slice(5)}
          </div>
          <div className="space-y-1">
            {SERIES.map((s) => (
              <div key={s.key} className="flex items-center gap-2 text-sm">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                <span style={{ color: s.color }}>{s.label}: {tipData[s.key]}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ──── Totals sidebar ────

const STAT_ITEMS = [
  { key: 'users' as const, label: 'admin.registeredUsers', icon: Users, bg: '#e8e0d4', fg: '#7a6e62' },
  { key: 'sessions' as const, label: 'admin.recordingSessions', icon: Mic, bg: '#f0ddd0', fg: '#b07049' },
  { key: 'shares' as const, label: 'admin.shareLinks', icon: Share2, bg: '#d9e4d6', fg: '#6a8a62' },
  { key: 'folders' as const, label: 'admin.filesFolders', icon: FolderOpen, bg: '#e4d8cf', fg: '#9a7a64' },
];

// ──── Main component ────

export default function DashboardPanel() {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [agoText, setAgoText] = useState('');

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/stats', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        setStats(await res.json());
        setFetchedAt(new Date());
      }
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // Update "Generated X ago" text
  useEffect(() => {
    if (!fetchedAt) return;
    const update = () => {
      const sec = Math.floor((Date.now() - fetchedAt.getTime()) / 1000);
      if (sec < 60) setAgoText(t('admin.secondsAgo', { n: sec }));
      else setAgoText(t('admin.minutesAgo', { n: Math.floor(sec / 60) }));
    };
    update();
    const id = setInterval(update, 10000);
    return () => clearInterval(id);
  }, [fetchedAt, t]);

  return (
    <div>
      {/* 统计卡片（移动端横向滚动） */}
      <div className="flex gap-3 overflow-x-auto pb-2 mb-4 md:grid md:grid-cols-4 md:overflow-visible md:pb-0 md:mb-5">
        {STAT_ITEMS.map((item) => {
          const Icon = item.icon;
          const totals = {
            users: stats?.totals.users ?? 0,
            sessions: stats?.totals.sessions ?? 0,
            shares: stats?.totals.shares ?? 0,
            folders: stats?.totals.folders ?? 0,
          };
          return (
            <div
              key={item.key}
              className="flex items-center gap-3 bg-white rounded-xl border border-cream-200 p-4 min-w-[160px] flex-shrink-0 md:min-w-0"
            >
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: item.bg }}
              >
                <Icon className="w-5 h-5" style={{ color: item.fg }} />
              </div>
              <div>
                <div className="text-lg font-bold text-charcoal-800">
                  {loading ? '—' : totals[item.key].toLocaleString()}
                </div>
                <div className="text-xs text-charcoal-400 whitespace-nowrap">{t(item.label)}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 趋势图 */}
      <div className="bg-white rounded-xl border border-cream-200 p-5 min-w-0">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-charcoal-800">{t('admin.trends')}</h3>
          {agoText && (
            <span className="text-xs text-charcoal-400">{t('admin.generatedAgo', { time: agoText })}</span>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-[320px]">
            <div className="animate-pulse text-charcoal-400 text-sm">{t('common.loading')}</div>
          </div>
        ) : stats ? (
          <CombinedTrendChart data={stats.daily} />
        ) : (
          <div className="flex items-center justify-center h-[320px] text-charcoal-400 text-sm">
            {t('admin.failedToLoad')}
          </div>
        )}
      </div>
    </div>
  );
}
