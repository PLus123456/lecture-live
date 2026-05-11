'use client';

import { useEffect, useState, useCallback, useRef, useMemo, useId } from 'react';
import {
  Users, Mic, Share2, FolderOpen,
  TrendingUp, TrendingDown, Minus,
  RefreshCw, Calendar, Activity, Sparkles,
} from 'lucide-react';
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

type SeriesKey = 'newUsers' | 'recordings' | 'shares';
type RangeKey = '7d' | '14d' | '30d';

const SERIES: { key: SeriesKey; label: string; color: string; icon: typeof Users }[] = [
  { key: 'newUsers', label: 'admin.registeredUsers', color: '#7c9ac7', icon: Users },
  { key: 'recordings', label: 'admin.recordingSessions', color: '#c2864a', icon: Mic },
  { key: 'shares', label: 'admin.shareLinks', color: '#7dab8a', icon: Share2 },
];

// ──── Monotone cubic Hermite interpolation ────
function monotonePath(pts: { x: number; y: number }[], yMin: number, yMax: number): string {
  const n = pts.length;
  if (n < 2) return '';
  if (n === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;

  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x);
    dy.push(pts[i + 1].y - pts[i].y);
    m.push(dx[i] === 0 ? 0 : dy[i] / dx[i]);
  }

  const tangent: number[] = new Array(n);
  tangent[0] = m[0];
  tangent[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    tangent[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  }
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

  const clampY = (y: number) => Math.max(yMax, Math.min(yMin, y));
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

// ──── Inline sparkline (fills container width) ────
function Sparkline({ data, color }: { data: number[]; color: string }) {
  const W = 100;
  const H = 28;
  if (data.length < 2) {
    return <div className="h-7 w-full" />;
  }
  const max = Math.max(...data, 1);
  const points = data.map((v, i) => ({
    x: (i / (data.length - 1)) * W,
    y: H - 2 - (v / max) * (H - 4),
  }));
  const path = monotonePath(points, H - 2, 2);
  const last = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-7 w-full" preserveAspectRatio="none">
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={last.x} cy={last.y} r={1.8} fill={color} />
    </svg>
  );
}

// ──── KPI Card ────
function KpiCard({
  icon: Icon,
  label,
  value,
  delta,
  deltaLabel,
  spark,
  color,
  bg,
  loading,
}: {
  icon: typeof Users;
  label: string;
  value: number;
  delta: number | null;
  deltaLabel: string;
  spark: number[];
  color: string;
  bg: string;
  loading: boolean;
}) {
  const TrendIcon = delta === null || delta === 0 ? Minus : delta > 0 ? TrendingUp : TrendingDown;
  const trendClass =
    delta === null || delta === 0
      ? 'text-charcoal-400'
      : delta > 0
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-rose-500 dark:text-rose-400';
  const deltaText =
    delta === null
      ? '—'
      : delta === 0
        ? '0'
        : `${delta > 0 ? '+' : ''}${delta.toLocaleString()}`;

  return (
    <div className="group relative bg-white dark:bg-charcoal-800 rounded-2xl border border-cream-200 dark:border-charcoal-700 p-4 md:p-5 overflow-hidden animate-fade-in-up card-hover-lift">
      {/* 顶部渐变标记带 */}
      <div
        className="absolute inset-x-0 top-0 h-1 opacity-90"
        style={{ background: `linear-gradient(90deg, ${color}, transparent)` }}
      />
      {/* 头部：label + icon 同行；number 单独占一行避免挤压 */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 text-[10px] md:text-[11px] font-medium uppercase tracking-wider text-charcoal-400 dark:text-charcoal-500 truncate pt-1">
          {label}
        </div>
        <div
          className="flex-shrink-0 w-9 h-9 md:w-10 md:h-10 rounded-xl flex items-center justify-center"
          style={{ backgroundColor: bg }}
        >
          <Icon className="w-4 h-4 md:w-5 md:h-5" style={{ color }} />
        </div>
      </div>

      <div className="mt-2 text-2xl md:text-3xl font-bold tabular-nums text-charcoal-800 dark:text-cream-100 leading-none">
        {loading ? '—' : value.toLocaleString()}
      </div>

      {/* delta 行单独，全宽，文本不换行 */}
      <div className="mt-3 flex items-center min-w-0">
        <div
          className={`inline-flex items-center gap-1 text-[11px] md:text-xs font-medium whitespace-nowrap ${trendClass}`}
        >
          <TrendIcon className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="tabular-nums">{deltaText}</span>
          {deltaLabel && (
            <span className="text-charcoal-400 dark:text-charcoal-500 font-normal ml-0.5">
              {deltaLabel}
            </span>
          )}
        </div>
      </div>

      {/* sparkline 全宽放底部，避免横向挤压；空数据时占位维持等高 */}
      <div className="mt-2 h-7 -mx-1">
        {spark.length > 1 ? <Sparkline data={spark} color={color} /> : null}
      </div>
    </div>
  );
}

// ──── Activity heatmap (last 7 days) ────
function ActivityRow({
  label,
  values,
  color,
  max,
  weekdays,
}: {
  label: string;
  values: number[];
  color: string;
  max: number;
  weekdays: string[];
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-24 flex-shrink-0 text-xs font-medium text-charcoal-600 dark:text-cream-200 truncate">
        {label}
      </div>
      <div className="flex-1 grid grid-cols-7 gap-1.5">
        {values.map((v, i) => {
          const intensity = max > 0 ? v / max : 0;
          const opacity = v === 0 ? 0.18 : 0.35 + intensity * 0.65;
          return (
            <div
              key={i}
              className="relative h-7 rounded-md flex items-center justify-center"
              style={{ backgroundColor: color, opacity }}
              title={`${weekdays[i]}: ${v}`}
            >
              {v > 0 && (
                <span
                  className="text-[10px] font-semibold tabular-nums"
                  style={{ color: intensity > 0.5 ? 'white' : '#3a3a3a' }}
                >
                  {v}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ──── Trend chart ────
function CombinedTrendChart({ data, t }: { data: DailyStats[]; t: ReturnType<typeof useI18n>['t'] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // useId 给 clipPath / gradient 一个稳定且组件内唯一的 id 前缀（剥离冒号以兼容 url(#...) 引用）
  const idBase = useId().replace(/:/g, '');
  const W = 800;
  const H = 280;
  const padL = 36;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const [revealW, setRevealW] = useState(0);
  const [animDone, setAnimDone] = useState(false);
  // 注意：x 为 viewBox 坐标（用于 SVG 内部绘制），leftPx 为相对于 containerRef 的像素值（用于 HTML tooltip 定位）
  const [tooltip, setTooltip] = useState<{ visible: boolean; x: number; index: number; leftPx: number }>({
    visible: false, x: 0, index: 0, leftPx: 0,
  });

  // RAF 驱动的揭示动画。
  // 不用 SMIL <animate>，因为它的 begin="0s" 是相对父 SVG 时钟，
  // 切 tab 回来时 SVG 没重建 → 新挂的 <animate> 会被认为"已结束"，瞬移到 freeze 终态。
  useEffect(() => {
    if (!data.length) {
      setRevealW(0);
      setAnimDone(false);
      return;
    }
    setAnimDone(false);
    setRevealW(0);
    let raf = 0;
    let start = 0;
    const DUR = 1400;
    const tick = (now: number) => {
      if (!start) start = now;
      const t = Math.min(1, (now - start) / DUR);
      // ease-out cubic ≈ cubic-bezier(0.25, 0.1, 0.25, 1)
      const eased = 1 - Math.pow(1 - t, 3);
      setRevealW(eased * W);
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setAnimDone(true);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [data]);

  if (!data.length) {
    return (
      <div className="flex items-center justify-center text-charcoal-400 text-sm h-[280px]">
        {t('common.noData')}
      </div>
    );
  }

  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const allValues = data.flatMap((d) => [d.newUsers, d.recordings, d.shares]);
  const maxVal = Math.max(...allValues, 1);
  const niceStep = maxVal <= 5 ? 1 : maxVal <= 20 ? 5 : 10;
  const niceMax = Math.ceil(maxVal / niceStep) * niceStep;
  const yTicks: number[] = [];
  const yStep = niceMax <= 5 ? 1 : niceMax / 4;
  for (let v = 0; v <= niceMax; v += yStep) yTicks.push(Math.round(v));

  const xLabelStep = Math.max(1, Math.floor(data.length / 8));

  const toX = (i: number) => padL + (i / Math.max(1, data.length - 1)) * chartW;
  const toY = (v: number) => padT + chartH - (v / niceMax) * chartH;
  const yFloor = toY(0);
  const yCeil = toY(niceMax);

  const seriesPoints = SERIES.map((s) =>
    data.map((d, i) => ({ x: toX(i), y: toY(d[s.key] as number) })),
  );
  const seriesPaths = seriesPoints.map((pts) => monotonePath(pts, yFloor, yCeil));
  const seriesAreas = SERIES.map((_, si) => {
    const pts = seriesPoints[si];
    if (pts.length < 2) return '';
    const top = monotonePath(pts, yFloor, yCeil);
    return `${top} L${pts[pts.length - 1].x},${yFloor} L${pts[0].x},${yFloor} Z`;
  });

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    // SVG 用 preserveAspectRatio="xMidYMid meet"，视口宽高比 ≠ 800:280 时会出现 letterbox，
    // 直接用 (clientX - rect.left) / rect.width 推 SVG x 会偏移；用 SVG 自身 CTM 反变换才能精确。
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container) return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;

    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPt = pt.matrixTransform(ctm.inverse());

    let closest = 0;
    let minDist = Infinity;
    for (let i = 0; i < data.length; i++) {
      const dist = Math.abs(toX(i) - svgPt.x);
      if (dist < minDist) {
        minDist = dist;
        closest = i;
      }
    }

    const closestSvgX = toX(closest);
    // 将选中点的 SVG x 正向变换回屏幕坐标，再减去 container 左边距，得到 tooltip 的容器内像素位置
    const fwdPt = svg.createSVGPoint();
    fwdPt.x = closestSvgX;
    fwdPt.y = 0;
    const screenPt = fwdPt.matrixTransform(ctm);
    const containerRect = container.getBoundingClientRect();
    const leftPx = screenPt.x - containerRect.left;

    setTooltip({ visible: true, x: closestSvgX, index: closest, leftPx });
  };

  const handleMouseLeave = () => setTooltip((prev) => ({ ...prev, visible: false }));

  const tipData = data[tooltip.index];

  return (
    <div ref={containerRef} className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: 280 }}
        preserveAspectRatio="xMidYMid meet"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <defs>
          {SERIES.map((s) => (
            <linearGradient key={s.key} id={`grad-${s.key}-${idBase}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.18} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
          <clipPath id={`reveal-${idBase}`}>
            <rect x={0} y={0} width={revealW} height={H} />
          </clipPath>
        </defs>

        {/* 横向虚线网格 */}
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

        {/* 区域填充 + 折线（按动画 clip 揭示） */}
        <g clipPath={`url(#reveal-${idBase})`}>
          {SERIES.map((s, si) => (
            <path key={`area-${s.key}`} d={seriesAreas[si]} fill={`url(#grad-${s.key}-${idBase})`} />
          ))}
          {SERIES.map((s, si) => (
            <path
              key={s.key}
              d={seriesPaths[si]}
              fill="none"
              stroke={s.color}
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </g>

        {/* X 轴日期 */}
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

        {/* Hover 竖线 */}
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

        {/* Hover 高亮点 */}
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

      {/* 图例 */}
      <div className="flex items-center justify-center gap-5 mt-1">
        {SERIES.map((s) => (
          <div key={s.key} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: s.color }} />
            <span className="text-xs text-charcoal-500 dark:text-charcoal-400">{t(s.label)}</span>
          </div>
        ))}
      </div>

      {/* 浮动 tooltip */}
      {animDone && tooltip.visible && tipData && (
        <div
          className="absolute pointer-events-none bg-white/95 dark:bg-charcoal-800/95 backdrop-blur-sm border border-cream-200 dark:border-charcoal-700 rounded-lg shadow-lg px-3 py-2.5 z-10 min-w-[140px]"
          style={{
            left: tooltip.leftPx,
            top: 8,
            transform: tooltip.x > W * 0.7 ? 'translateX(-110%)' : 'translateX(10px)',
          }}
        >
          <div className="text-xs font-semibold text-charcoal-700 dark:text-cream-200 mb-1.5 pb-1.5 border-b border-cream-100 dark:border-charcoal-700">
            {tipData.date}
          </div>
          <div className="space-y-1">
            {SERIES.map((s) => (
              <div key={s.key} className="flex items-center gap-2 text-xs">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                <span className="text-charcoal-500 dark:text-charcoal-400">{t(s.label)}</span>
                <span className="ml-auto font-semibold tabular-nums text-charcoal-700 dark:text-cream-200">
                  {tipData[s.key]}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ──── Distribution 3D bar chart ────
// 用 SVG 绘制等距投影 (isometric) 的 3D 柱状图：每根柱由前面 / 顶面 / 右侧面 三个多边形组成。
function Distribution3DBars({
  totals,
  t,
}: {
  totals: { users: number; sessions: number; shares: number; folders: number };
  t: ReturnType<typeof useI18n>['t'];
}) {
  const items = [
    { key: 'users', label: t('admin.registeredUsers'), value: totals.users, color: '#7c9ac7' },
    { key: 'sessions', label: t('admin.recordingSessions'), value: totals.sessions, color: '#c2864a' },
    { key: 'shares', label: t('admin.shareLinks'), value: totals.shares, color: '#7dab8a' },
    { key: 'folders', label: t('admin.filesFolders'), value: totals.folders, color: '#9a7a64' },
  ];
  const total = items.reduce((acc, i) => acc + i.value, 0);
  const maxVal = Math.max(...items.map((i) => i.value), 1);

  const [hover, setHover] = useState<number | null>(null);
  const [animKey, setAnimKey] = useState(0);
  useEffect(() => {
    setAnimKey((k) => k + 1);
  }, [totals.users, totals.sessions, totals.shares, totals.folders]);

  // 画布参数
  const W = 320;
  const H = 220;
  const padL = 24;
  const padR = 24;
  // padT 需同时容纳 3D 顶面(depth=14) + 数字标签(11px) + 与柱顶间距(6px) + hover 抬升(6px)
  const padT = 32;
  const padB = 36;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const slot = chartW / items.length;
  const barW = slot * 0.5;
  const depth = 14; // 3D 透视深度

  // 颜色亮/暗变体（用 HSL 偏移做顶面/右面的高光与阴影）
  const shade = (hex: string, dl: number) => {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    const adjust = (c: number) => Math.max(0, Math.min(255, Math.round(c + dl)));
    const hex2 = (n: number) => n.toString(16).padStart(2, '0');
    return `#${hex2(adjust(r))}${hex2(adjust(g))}${hex2(adjust(b))}`;
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="relative flex-shrink-0 w-full" style={{ height: H }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-full"
          preserveAspectRatio="xMidYMid meet"
          key={animKey}
        >
          <defs>
            {items.map((it) => (
              <linearGradient key={it.key} id={`bar-front-${it.key}-${animKey}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={shade(it.color, 12)} />
                <stop offset="100%" stopColor={shade(it.color, -18)} />
              </linearGradient>
            ))}
            {/* 地板阴影 */}
            <radialGradient id={`floor-shadow-${animKey}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#000" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#000" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* 等距网格地板 — 给一种"立体平面"的暗示 */}
          <g opacity="0.35">
            {[0, 1, 2, 3].map((i) => {
              const y = padT + chartH - (i / 3) * chartH;
              return (
                <line
                  key={`grid-${i}`}
                  x1={padL}
                  y1={y}
                  x2={padL + chartW + depth}
                  y2={y - depth}
                  stroke="#e2dac9"
                  strokeWidth={1}
                  strokeDasharray="2 3"
                />
              );
            })}
          </g>

          {items.map((it, i) => {
            const frac = it.value / maxVal;
            const h = Math.max(2, frac * (chartH - 8));
            const xLeft = padL + slot * i + (slot - barW) / 2;
            const yTop = padT + chartH - h;
            const yBottom = padT + chartH;
            const isHover = hover === i;
            const lift = isHover ? 6 : 0;

            // 三个面的多边形
            const front = `${xLeft},${yTop - lift} ${xLeft + barW},${yTop - lift} ${xLeft + barW},${yBottom - lift} ${xLeft},${yBottom - lift}`;
            const top = `${xLeft},${yTop - lift} ${xLeft + depth},${yTop - depth - lift} ${xLeft + barW + depth},${yTop - depth - lift} ${xLeft + barW},${yTop - lift}`;
            const side = `${xLeft + barW},${yTop - lift} ${xLeft + barW + depth},${yTop - depth - lift} ${xLeft + barW + depth},${yBottom - depth - lift} ${xLeft + barW},${yBottom - lift}`;

            return (
              <g
                key={it.key}
                style={{
                  transition: 'transform 200ms ease-out, filter 200ms',
                  transformOrigin: `${xLeft + barW / 2}px ${yBottom}px`,
                  filter: isHover ? 'drop-shadow(0 6px 8px rgba(0,0,0,0.18))' : 'none',
                  cursor: 'pointer',
                }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                {/* 地板阴影椭圆 */}
                <ellipse
                  cx={xLeft + barW / 2 + depth / 2}
                  cy={yBottom + 4}
                  rx={barW * 0.7}
                  ry={4}
                  fill={`url(#floor-shadow-${animKey})`}
                />
                {/* 入场动画 — 从底部生长 */}
                <g style={{ transformOrigin: `${xLeft + barW / 2}px ${yBottom}px` }}>
                  <polygon
                    points={side}
                    fill={shade(it.color, -32)}
                    style={{
                      transformOrigin: `${xLeft + barW / 2}px ${yBottom}px`,
                      animation: `barRise 700ms cubic-bezier(0.25, 1, 0.4, 1) ${i * 100}ms backwards`,
                    }}
                  />
                  <polygon
                    points={top}
                    fill={shade(it.color, 22)}
                    style={{
                      transformOrigin: `${xLeft + barW / 2}px ${yBottom}px`,
                      animation: `barRise 700ms cubic-bezier(0.25, 1, 0.4, 1) ${i * 100}ms backwards`,
                    }}
                  />
                  <polygon
                    points={front}
                    fill={`url(#bar-front-${it.key}-${animKey})`}
                    style={{
                      transformOrigin: `${xLeft + barW / 2}px ${yBottom}px`,
                      animation: `barRise 700ms cubic-bezier(0.25, 1, 0.4, 1) ${i * 100}ms backwards`,
                    }}
                  />

                  {/* 顶部数值 */}
                  <text
                    x={xLeft + barW / 2 + depth / 2}
                    y={yTop - depth - 6 - lift}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight={600}
                    fill="#5a4f43"
                    style={{ animation: `barRise 700ms cubic-bezier(0.25, 1, 0.4, 1) ${i * 100 + 200}ms backwards` }}
                  >
                    {it.value.toLocaleString()}
                  </text>
                </g>

                {/* X 轴文字 */}
                <text
                  x={xLeft + barW / 2 + depth / 2}
                  y={H - 14}
                  textAnchor="middle"
                  fontSize={10}
                  fill="#9c8e7d"
                >
                  {it.label.length > 6 ? it.label.slice(0, 5) + '…' : it.label}
                </text>
              </g>
            );
          })}
          <style>{`
            @keyframes barRise {
              0% { transform: scaleY(0.02); opacity: 0; }
              60% { opacity: 1; }
              100% { transform: scaleY(1); opacity: 1; }
            }
          `}</style>
        </svg>
      </div>

      {/* 底部图例 + 数值表 */}
      <div className="flex-1 min-w-0 space-y-1.5 pt-1 border-t border-cream-100 dark:border-charcoal-700">
        <div className="flex items-center justify-between text-[11px] text-charcoal-400 dark:text-charcoal-500 pt-1.5">
          <span>{t('admin.totals')}</span>
          <span className="font-semibold tabular-nums text-charcoal-700 dark:text-cream-200">
            {total.toLocaleString()}
          </span>
        </div>
        {items.map((it, i) => {
          const pct = total > 0 ? Math.round((it.value / total) * 100) : 0;
          const isHover = hover === i;
          return (
            <div
              key={it.key}
              className={`flex items-center gap-2 text-xs rounded px-1 py-0.5 transition-colors ${isHover ? 'bg-cream-100 dark:bg-charcoal-700' : ''}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <span
                className="w-2 h-2 rounded-sm flex-shrink-0"
                style={{ backgroundColor: it.color }}
              />
              <span className="flex-1 text-charcoal-600 dark:text-cream-200 truncate">{it.label}</span>
              <span className="font-semibold tabular-nums text-charcoal-700 dark:text-cream-200">
                {it.value.toLocaleString()}
              </span>
              <span className="w-7 text-right text-charcoal-400 dark:text-charcoal-500 tabular-nums">
                {pct}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ──── Main panel ────
export default function DashboardPanel() {
  const { t, locale } = useI18n();
  const token = useAuthStore((s) => s.token);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [agoText, setAgoText] = useState('');
  const [range, setRange] = useState<RangeKey>('14d');

  const fetchStats = useCallback(
    async (silent = false) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
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
        setRefreshing(false);
      }
    },
    [token],
  );

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // 「生成于 X 前」自动更新
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

  // 切片到选定时间窗口
  const days = useMemo(() => {
    if (!stats?.daily) return [];
    const n = range === '7d' ? 7 : range === '14d' ? 14 : 30;
    return stats.daily.slice(-n);
  }, [stats, range]);

  // 派生 KPI
  const kpis = useMemo(() => {
    if (!stats?.daily?.length) {
      return SERIES.map((s) => ({ key: s.key, today: 0, delta: null as number | null, spark: [] as number[], week: 0 }));
    }
    const all = stats.daily;
    const last7 = all.slice(-7);
    const prev7 = all.slice(-14, -7);

    return SERIES.map((s) => {
      const today = all[all.length - 1]?.[s.key] ?? 0;
      const yesterday = all[all.length - 2]?.[s.key] ?? 0;
      const week = last7.reduce((acc, d) => acc + (d[s.key] as number), 0);
      const prevWeek = prev7.reduce((acc, d) => acc + (d[s.key] as number), 0);
      // 主要展示「本周 vs 上周」差值（信号比单日更稳）
      const delta = prev7.length > 0 ? week - prevWeek : null;
      const spark = last7.map((d) => d[s.key] as number);
      return { key: s.key, today, yesterday, delta, spark, week, prevWeek };
    });
  }, [stats]);

  // 7 日热度网格
  const heatmap = useMemo(() => {
    if (!stats?.daily?.length) {
      return { weekdays: [] as string[], rows: SERIES.map((s) => ({ key: s.key, values: [] as number[] })) , max: 0 };
    }
    const last7 = stats.daily.slice(-7);
    const weekdayFmt = new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short' });
    const weekdays = last7.map((d) => {
      // 用本地日期解析避免 UTC 偏移影响周几
      const [y, m, day] = d.date.split('-').map(Number);
      return weekdayFmt.format(new Date(y, m - 1, day));
    });
    const rows = SERIES.map((s) => ({
      key: s.key,
      values: last7.map((d) => d[s.key] as number),
      label: t(s.label),
      color: s.color,
    }));
    const max = Math.max(...rows.flatMap((r) => r.values), 0);
    return { weekdays, rows, max };
  }, [stats, locale, t]);

  // 关键洞察（最忙日 + 七日总数）
  const insights = useMemo(() => {
    if (!stats?.daily?.length) return null;
    const last7 = stats.daily.slice(-7);
    const total7 = last7.reduce((acc, d) => acc + d.newUsers + d.recordings + d.shares, 0);
    let busy = last7[0];
    for (const d of last7) {
      const sum = d.newUsers + d.recordings + d.shares;
      const cur = busy.newUsers + busy.recordings + busy.shares;
      if (sum > cur) busy = d;
    }
    return {
      total7,
      busiest: busy,
      sevenDayUsers: last7.reduce((a, d) => a + d.newUsers, 0),
      sevenDaySessions: last7.reduce((a, d) => a + d.recordings, 0),
      sevenDayShares: last7.reduce((a, d) => a + d.shares, 0),
    };
  }, [stats]);

  const totals = useMemo(
    () => stats?.totals ?? { users: 0, sessions: 0, shares: 0, folders: 0 },
    [stats],
  );
  const totalsByKey = useMemo(
    () => ({
      newUsers: totals.users,
      recordings: totals.sessions,
      shares: totals.shares,
    }),
    [totals],
  );

  const KPI_BG: Record<SeriesKey, string> = {
    newUsers: '#e8e0d4',
    recordings: '#f0ddd0',
    shares: '#d9e4d6',
  };

  return (
    <div className="space-y-5">
      {/* ── 顶部 Hero：标题 + 刷新 ── */}
      <div className="flex items-end justify-between gap-3 animate-fade-in-up">
        <div className="min-w-0">
          <h2 className="text-xl md:text-2xl font-serif font-bold text-charcoal-800 dark:text-cream-100">
            {t('admin.overview')}
          </h2>
          <p className="text-sm text-charcoal-500 dark:text-charcoal-400 mt-1">
            {t('admin.overviewSubtitle')}
            {agoText && (
              <span className="ml-2 text-charcoal-400 dark:text-charcoal-500">
                · {t('admin.generatedAgo', { time: agoText })}
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => fetchStats(true)}
          disabled={refreshing || loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-charcoal-600 dark:text-cream-200 bg-white dark:bg-charcoal-800 border border-cream-200 dark:border-charcoal-700 rounded-lg hover:bg-cream-50 dark:hover:bg-charcoal-700 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {t('admin.refresh')}
        </button>
      </div>

      {/* ── KPI 卡片栏 ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        {/* 用户 / 会话 / 分享：来自 daily 派生 */}
        {SERIES.map((s, i) => {
          const k = kpis[i];
          return (
            <div key={s.key} className="stagger-1" style={{ animationDelay: `${i * 60}ms` }}>
              <KpiCard
                icon={s.icon}
                label={t(s.label)}
                value={totalsByKey[s.key]}
                delta={k.delta}
                deltaLabel={t('admin.vsLastWeek')}
                spark={k.spark}
                color={s.color}
                bg={KPI_BG[s.key]}
                loading={loading}
              />
            </div>
          );
        })}
        {/* 文件夹（无 daily 数据，独立卡片，无 delta） */}
        <div className="stagger-1" style={{ animationDelay: '180ms' }}>
          <KpiCard
            icon={FolderOpen}
            label={t('admin.filesFolders')}
            value={totals.folders}
            delta={null}
            deltaLabel=""
            spark={[]}
            color="#9a7a64"
            bg="#e4d8cf"
            loading={loading}
          />
        </div>
      </div>

      {/* ── 主体：左 趋势图 + 右 分布/洞察 ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* 趋势图（占 2/3） */}
        <div className="lg:col-span-2 bg-white dark:bg-charcoal-800 rounded-2xl border border-cream-200 dark:border-charcoal-700 p-5 animate-fade-in-up stagger-3">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-charcoal-400 dark:text-charcoal-500" />
              <h3 className="text-sm font-semibold text-charcoal-800 dark:text-cream-100">
                {t('admin.trendsCardTitle')}
              </h3>
            </div>
            {/* 时间窗切换 */}
            <div className="inline-flex items-center bg-cream-100 dark:bg-charcoal-700 rounded-lg p-0.5">
              {(['7d', '14d', '30d'] as RangeKey[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    range === r
                      ? 'bg-white dark:bg-charcoal-600 text-charcoal-800 dark:text-cream-100 shadow-sm'
                      : 'text-charcoal-500 dark:text-charcoal-400 hover:text-charcoal-700 dark:hover:text-cream-200'
                  }`}
                >
                  {t(`admin.range${r === '7d' ? '7d' : r === '14d' ? '14d' : '30d'}`)}
                </button>
              ))}
            </div>
          </div>
          {loading ? (
            <div className="flex items-center justify-center h-[280px]">
              <div className="animate-pulse text-charcoal-400 text-sm">{t('common.loading')}</div>
            </div>
          ) : days.length ? (
            <CombinedTrendChart data={days} t={t} />
          ) : (
            <div className="flex items-center justify-center h-[280px] text-charcoal-400 text-sm">
              {t('admin.failedToLoad')}
            </div>
          )}
        </div>

        {/* 右：分布 donut */}
        <div className="bg-white dark:bg-charcoal-800 rounded-2xl border border-cream-200 dark:border-charcoal-700 p-5 animate-fade-in-up stagger-4">
          <div className="flex items-center gap-2 mb-4">
            <Calendar className="w-4 h-4 text-charcoal-400 dark:text-charcoal-500" />
            <h3 className="text-sm font-semibold text-charcoal-800 dark:text-cream-100">
              {t('admin.distributionCardTitle')}
            </h3>
          </div>
          {loading ? (
            <div className="flex items-center justify-center h-[140px]">
              <div className="animate-pulse text-charcoal-400 text-sm">{t('common.loading')}</div>
            </div>
          ) : (
            <Distribution3DBars totals={totals} t={t} />
          )}
        </div>
      </div>

      {/* ── 底部：活跃度热图 + 洞察 ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* 活跃度热图（占 2/3） */}
        <div className="lg:col-span-2 bg-white dark:bg-charcoal-800 rounded-2xl border border-cream-200 dark:border-charcoal-700 p-5 animate-fade-in-up stagger-5">
          <h3 className="text-sm font-semibold text-charcoal-800 dark:text-cream-100 mb-4">
            {t('admin.activityHeatmap')}
          </h3>
          {loading ? (
            <div className="flex items-center justify-center h-[120px]">
              <div className="animate-pulse text-charcoal-400 text-sm">{t('common.loading')}</div>
            </div>
          ) : heatmap.weekdays.length === 0 ? (
            <div className="flex items-center justify-center h-[120px] text-charcoal-400 text-sm">
              {t('common.noData')}
            </div>
          ) : (
            <div className="space-y-2.5">
              {/* 周几标题行 */}
              <div className="flex items-center gap-3">
                <div className="w-24 flex-shrink-0" />
                <div className="flex-1 grid grid-cols-7 gap-1.5">
                  {heatmap.weekdays.map((wd, i) => (
                    <div
                      key={i}
                      className="text-center text-[10px] uppercase tracking-wider text-charcoal-400 dark:text-charcoal-500"
                    >
                      {wd}
                    </div>
                  ))}
                </div>
              </div>
              {SERIES.map((s, si) => (
                <ActivityRow
                  key={s.key}
                  label={t(s.label)}
                  values={heatmap.rows[si].values}
                  color={s.color}
                  max={heatmap.max}
                  weekdays={heatmap.weekdays}
                />
              ))}
            </div>
          )}
        </div>

        {/* 洞察卡 */}
        <div className="bg-white dark:bg-charcoal-800 rounded-2xl border border-cream-200 dark:border-charcoal-700 p-5 animate-fade-in-up stagger-6">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-4 h-4 text-rust-400" />
            <h3 className="text-sm font-semibold text-charcoal-800 dark:text-cream-100">
              {t('admin.insightsCardTitle')}
            </h3>
          </div>
          {loading || !insights ? (
            <div className="flex items-center justify-center h-[120px]">
              <div className="animate-pulse text-charcoal-400 text-sm">{t('common.loading')}</div>
            </div>
          ) : insights.total7 === 0 ? (
            <div className="flex items-center justify-center h-[120px] text-charcoal-400 text-sm text-center px-2">
              {t('admin.insightZeroActivity')}
            </div>
          ) : (
            <ul className="space-y-3 text-sm">
              <InsightRow
                color="#7c9ac7"
                text={t('admin.insightUsers7d', { n: insights.sevenDayUsers })}
              />
              <InsightRow
                color="#c2864a"
                text={t('admin.insightSessions7d', { n: insights.sevenDaySessions })}
              />
              <InsightRow
                color="#7dab8a"
                text={t('admin.insightShares7d', { n: insights.sevenDayShares })}
              />
              <li className="pt-3 mt-1 border-t border-cream-100 dark:border-charcoal-700">
                <div className="text-[11px] uppercase tracking-wider text-charcoal-400 dark:text-charcoal-500">
                  {t('admin.busiestDay')}
                </div>
                <div className="mt-1 text-base font-semibold text-charcoal-800 dark:text-cream-100 tabular-nums">
                  {insights.busiest.date}
                </div>
                <div className="text-xs text-charcoal-500 dark:text-charcoal-400 tabular-nums">
                  {insights.busiest.newUsers + insights.busiest.recordings + insights.busiest.shares}{' '}
                  <span className="text-charcoal-400 dark:text-charcoal-500">
                    ({insights.busiest.newUsers} · {insights.busiest.recordings} · {insights.busiest.shares})
                  </span>
                </div>
              </li>
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function InsightRow({ color, text }: { color: string; text: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <span
        className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ backgroundColor: color }}
      />
      <span className="text-charcoal-600 dark:text-cream-200 leading-relaxed">{text}</span>
    </li>
  );
}
