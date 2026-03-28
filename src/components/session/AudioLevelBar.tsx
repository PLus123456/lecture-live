'use client';

// v2.1 §B.3: Audio level visualization bar
// Used in NewSessionDialog preview and ControlBar during recording

import { useRef } from 'react';

interface AudioLevelBarProps {
  level: number;          // 0.0 ~ 1.0
  barCount?: number;      // number of bars, default 32
  height?: number;        // pixel height
}

export function AudioLevelBar({ level, barCount = 32, height = 32 }: AudioLevelBarProps) {
  // Use a seeded random array so bars don't jitter randomly every frame
  const jitterRef = useRef<number[]>([]);
  if (jitterRef.current.length !== barCount) {
    jitterRef.current = Array.from({ length: barCount }, () => 0.7 + Math.random() * 0.3);
  }

  return (
    <div className="flex items-end justify-center gap-[2px]" style={{ height }}>
      {Array.from({ length: barCount }).map((_, i) => {
        const position = i / barCount;
        const distance = Math.abs(position - 0.5) * 2; // center tall, edges short
        const jitter = jitterRef.current[i];
        const barHeight = Math.max(2, level * height * (1 - distance * 0.5) * jitter);

        const color =
          level > 0.7
            ? 'bg-red-500'
            : level > 0.3
              ? 'bg-yellow-500'
              : 'bg-emerald-500';

        return (
          <div
            key={i}
            className={`w-[3px] rounded-full transition-all duration-75 ${color}`}
            style={{ height: `${barHeight}px` }}
          />
        );
      })}
    </div>
  );
}

// Simpler inline version for tight spaces (e.g., ControlBar)
export function AudioLevelDot({ level }: { level: number }) {
  const color =
    level > 0.7
      ? 'bg-red-500'
      : level > 0.3
        ? 'bg-yellow-500'
        : level > 0.05
          ? 'bg-emerald-500'
          : 'bg-charcoal-300';

  const scale = 1 + level * 0.5;

  return (
    <div
      className={`w-2.5 h-2.5 rounded-full transition-all duration-75 ${color}`}
      style={{ transform: `scale(${scale})` }}
    />
  );
}
