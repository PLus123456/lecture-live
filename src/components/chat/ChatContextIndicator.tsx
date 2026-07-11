'use client';

/**
 * 上下文用量小圈 + 详情卡 —— 从 ChatTab 的同名内联组件抽出，供 GlobalChat（对话详情）复用。
 *
 * 小圈按当前 used/budget 画环形进度，颜色随占用升高由绿→黄→红，上下文满（EOL）时转紫。
 * 点开显示：用量条 + 各部分 token 明细 + 「输入 /compress 主动压缩历史」提示。
 * 自带开合、外部点击关闭与进出场动画，父组件只需传 tokenUsage / contextFull。
 */

import { useEffect, useRef, useState } from 'react';
import { useExitAnimation } from '@/hooks/useExitAnimation';
import type { ChatTokenUsage } from '@/stores/chatStore';

function getRingColor(percent: number, contextFull: boolean): { stroke: string } {
  if (contextFull) return { stroke: '#7c3aed' }; // 紫：RAG/EOL
  if (percent < 0.6) return { stroke: '#059669' };
  if (percent < 0.85) return { stroke: '#d97706' };
  return { stroke: '#dc2626' };
}

function BreakdownRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between text-charcoal-500">
      <span>{label}</span>
      <span className="font-mono">
        {value > 1000 ? `${(value / 1000).toFixed(1)}K` : value}
      </span>
    </div>
  );
}

export default function ChatContextIndicator({
  tokenUsage,
  contextFull,
}: {
  tokenUsage: ChatTokenUsage | null;
  contextFull: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anim = useExitAnimation(open, 150);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const used = tokenUsage?.used ?? 0;
  const budget = tokenUsage?.budget ?? 0;
  const percent = budget > 0 ? Math.min(1, used / budget) : 0;
  const level = tokenUsage?.level ?? 1;
  const breakdown = tokenUsage?.breakdown;

  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - percent);
  const palette = getRingColor(percent, contextFull);
  const displayPercent = Math.round(percent * 100);

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`上下文 ${displayPercent}% · 降级级别 L${level}`}
        aria-label={`上下文 ${displayPercent}%`}
        className="relative w-5 h-5 rounded-full flex items-center justify-center
                   hover:bg-cream-100 transition-colors"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5 -rotate-90">
          <circle cx="12" cy="12" r={radius} fill="none" stroke="#e5e7eb" strokeWidth="2" />
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke={palette.stroke}
            strokeWidth="2"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
          />
        </svg>
      </button>

      {anim.mounted && (
        <div
          className={`absolute bottom-full right-0 mb-2 w-72 bg-white border border-cream-300
                      rounded-lg shadow-lg z-50 p-3 text-xs
                      ${anim.leaving ? 'animate-fade-out-scale' : 'animate-fade-in-scale'}`}
        >
          <div className="mb-1">
            <div className="flex items-center justify-between mb-1">
              <span className="text-charcoal-500">上下文用量</span>
              <span className="font-mono text-charcoal-700">
                {Math.round(percent * 100)}% · L{level}
              </span>
            </div>
            <div className="h-1.5 bg-cream-200 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${percent * 100}%`, backgroundColor: getRingColor(percent, false).stroke }}
              />
            </div>
            <div className="text-[10px] text-charcoal-400 mt-1 text-right">
              {(used / 1000).toFixed(1)}K / {(budget / 1000).toFixed(1)}K tokens
            </div>
          </div>

          {breakdown && (
            <div className="space-y-0.5 text-[10px] mt-2">
              <BreakdownRow label="系统提示" value={breakdown.systemPrompt} />
              <BreakdownRow label="转录稿" value={breakdown.transcript} />
              <BreakdownRow label="摘要" value={breakdown.summary} />
              <BreakdownRow label="历史对话" value={breakdown.history} />
              <BreakdownRow label="当前输入" value={breakdown.userInput} />
            </div>
          )}

          <div className="mt-2 pt-2 border-t border-cream-200 text-[10px] text-charcoal-400">
            输入 <code className="bg-cream-100 px-1 rounded">/compress</code> 主动压缩历史
          </div>
        </div>
      )}
    </div>
  );
}
