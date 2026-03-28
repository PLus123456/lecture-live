'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import FlagImg from '@/components/FlagImg';
import { LANGUAGES } from '@/lib/languages';
import { ChevronDown } from 'lucide-react';

interface LanguageSelectProps {
  value: string;
  onChange: (code: string) => void;
  /** 是否显示 "None" 选项（用于翻译目标语言） */
  allowNone?: boolean;
  noneLabel?: string;
  /** 排除的语言代码（如排除已选的源语言） */
  excludeCodes?: string[];
  /** 额外的 className */
  className?: string;
  /** 使用 name（原文）还是 label（英文），默认 name */
  displayMode?: 'name' | 'label';
}

/**
 * 带国旗图片的自定义语言下拉选择器
 * 替代原生 <select>，解决 <option> 无法嵌入图片的问题
 */
export default function LanguageSelect({
  value,
  onChange,
  allowNone = false,
  noneLabel = 'None',
  excludeCodes = [],
  className = '',
  displayMode = 'name',
}: LanguageSelectProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filteredLangs = LANGUAGES.filter((l) => !excludeCodes.includes(l.code));
  const selected = LANGUAGES.find((l) => l.code === value);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // 打开时滚动到当前选中项
  useEffect(() => {
    if (open && listRef.current && value) {
      const activeEl = listRef.current.querySelector(`[data-code="${value}"]`);
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [open, value]);

  // ESC 关闭
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    },
    []
  );

  const handleSelect = (code: string) => {
    onChange(code);
    setOpen(false);
  };

  const displayText = selected
    ? (displayMode === 'label' ? selected.label : selected.name)
    : (allowNone ? noneLabel : '');

  return (
    <div ref={containerRef} className={`relative ${className}`} onKeyDown={handleKeyDown}>
      {/* 触发按钮 */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-cream-300 bg-white
                   text-sm text-charcoal-700 hover:border-cream-400
                   focus:outline-none focus:border-rust-300 focus:ring-1 focus:ring-rust-200
                   transition-colors"
      >
        {selected ? (
          <FlagImg code={selected.code} type="lang" size={16} />
        ) : allowNone ? (
          <span className="w-4 h-3 inline-block rounded-[2px] bg-cream-200" />
        ) : null}
        <span className="flex-1 text-left truncate">{displayText}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-charcoal-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* 下拉列表 */}
      {open && (
        <div
          ref={listRef}
          className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto
                     bg-white rounded-lg border border-cream-200 shadow-lg
                     py-1"
        >
          {allowNone && (
            <button
              type="button"
              onClick={() => handleSelect('')}
              data-code=""
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left
                         hover:bg-cream-50 transition-colors
                         ${value === '' ? 'bg-rust-50 text-rust-700 font-medium' : 'text-charcoal-600'}`}
            >
              <span className="w-4 h-3 inline-block rounded-[2px] bg-cream-200 shrink-0" />
              <span className="truncate">{noneLabel}</span>
            </button>
          )}
          {filteredLangs.map((lang) => {
            const isActive = lang.code === value;
            return (
              <button
                key={lang.code}
                type="button"
                onClick={() => handleSelect(lang.code)}
                data-code={lang.code}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left
                           hover:bg-cream-50 transition-colors
                           ${isActive ? 'bg-rust-50 text-rust-700 font-medium' : 'text-charcoal-600'}`}
              >
                <FlagImg code={lang.code} type="lang" size={16} className="shrink-0" />
                <span className="truncate">
                  {displayMode === 'label' ? lang.label : lang.name}
                </span>
                <span className="ml-auto text-[10px] text-charcoal-400 uppercase">{lang.code}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
