'use client';

/**
 * 全局对话 (`/chat`) 用的录音附加选择器。
 *
 * 这是一个独立可复用的 modal——U10 的 GlobalChat 会 import 并在用户点击
 * "附加录音" 时打开它。组件本身不依赖 U10 的任何 store/组件。
 *
 * 行为：
 *  - open 时拉取 `GET /api/sessions?limit=100`，客户端过滤 status === 'COMPLETED'
 *  - 搜索框 debounce 300ms，按 title + courseName 模糊匹配
 *  - 多选 + 顶部 "全选可见" 复选框（仅切换当前过滤后的 visible 列表）
 *  - alreadyAttached 中的 sessionId 会预选且不可改（行标为"已附加"灰态）
 *  - "附加选中 (N)" 调用 POST `/api/conversations/{conversationId}/recordings`
 *    携带 { sessionIds: selected }；U9 还没合并时会返回 404，错误吐 toast，
 *    modal 保持打开方便用户重试或取消。
 *  - Esc 关闭；行 Enter 切换该行选择。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  X,
  Search,
  Check,
  Loader2,
  FileText,
  Calendar,
  Clock,
  Mic,
} from 'lucide-react';
import ModalPortal from '@/components/ModalPortal';
import { useAuth } from '@/hooks/useAuth';
import { useExitAnimation } from '@/hooks/useExitAnimation';
import { toast } from '@/stores/toastStore';

interface RecordingItem {
  id: string;
  title: string;
  courseName?: string | null;
  createdAt: string;
  durationMs: number;
  status: string;
}

export interface RecordingPickerProps {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  alreadyAttached?: ReadonlyArray<string>;
  onAttached: (newSessionIds: string[]) => void;
}

/**
 * 把 Session 列表 + 查询字符串 过滤成 visible 列表。
 * 抽成纯函数方便单测，不依赖 React。
 */
export function filterRecordings(
  items: ReadonlyArray<RecordingItem>,
  query: string,
): RecordingItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((r) => {
    const title = (r.title ?? '').toLowerCase();
    const course = (r.courseName ?? '').toLowerCase();
    return title.includes(q) || course.includes(q);
  });
}

/**
 * 给定当前 selected 集合 + visible 列表 + alreadyAttached，
 * 返回 select-all-visible 的下一个状态：
 *  - 若 visible 里所有"可选"项都已选 → 取消选中（移除它们）
 *  - 否则 → 全部选中
 *
 * "可选"= 不在 alreadyAttached 里（alreadyAttached 已经附加，不能再选）
 *
 * 抽成纯函数方便单测。
 */
export function toggleSelectAllVisible(
  selected: ReadonlyArray<string>,
  visible: ReadonlyArray<RecordingItem>,
  alreadyAttached: ReadonlyArray<string>,
): string[] {
  const attachedSet = new Set(alreadyAttached);
  const selectableIds = visible.map((r) => r.id).filter((id) => !attachedSet.has(id));
  if (selectableIds.length === 0) return [...selected];
  const selectedSet = new Set(selected);
  const allSelected = selectableIds.every((id) => selectedSet.has(id));
  if (allSelected) {
    // 反选：把 visible 里的可选项从 selected 中移除
    const selectableSet = new Set(selectableIds);
    return selected.filter((id) => !selectableSet.has(id));
  }
  // 否则：把 visible 里所有可选项都加入 selected（保留已有的）
  const merged = new Set(selected);
  for (const id of selectableIds) merged.add(id);
  return Array.from(merged);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '< 1 分钟';
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${h}:00`;
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export default function RecordingPicker({
  open,
  onClose,
  conversationId,
  alreadyAttached = [],
  onAttached,
}: RecordingPickerProps) {
  const { token } = useAuth();
  const { mounted, leaving } = useExitAnimation(open);

  const [items, setItems] = useState<RecordingItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rawSearch, setRawSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // 关闭时重置（避免下次打开还保留旧的 selected / search）
  useEffect(() => {
    if (!open) {
      setRawSearch('');
      setDebouncedSearch('');
      setSelected([]);
      setLoadError(null);
    }
  }, [open]);

  // 搜索 debounce 300ms
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(rawSearch), 300);
    return () => window.clearTimeout(id);
  }, [rawSearch]);

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetch('/api/sessions?limit=100', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: unknown) => {
        if (cancelled) return;
        // GET /api/sessions 在 limit 模式下返回 { items, nextCursor, ... }，
        // 不带 limit 时返回纯数组——两种格式都兼容。
        const list: unknown = Array.isArray(data)
          ? data
          : (data as { items?: unknown })?.items ?? [];
        if (!Array.isArray(list)) {
          setItems([]);
          return;
        }
        const cleaned: RecordingItem[] = list
          .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
          .filter((s) => s.status === 'COMPLETED')
          .map((s) => ({
            id: String(s.id),
            title: typeof s.title === 'string' ? s.title : '',
            courseName:
              typeof s.courseName === 'string' ? s.courseName : null,
            createdAt:
              typeof s.createdAt === 'string'
                ? s.createdAt
                : new Date().toISOString(),
            durationMs:
              typeof s.durationMs === 'number' ? s.durationMs : 0,
            status: typeof s.status === 'string' ? s.status : 'COMPLETED',
          }));
        setItems(cleaned);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, token]);

  const visible = useMemo(
    () => filterRecordings(items, debouncedSearch),
    [items, debouncedSearch],
  );

  const attachedSet = useMemo(
    () => new Set(alreadyAttached),
    [alreadyAttached],
  );

  const visibleSelectableIds = useMemo(
    () => visible.map((r) => r.id).filter((id) => !attachedSet.has(id)),
    [visible, attachedSet],
  );
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allVisibleSelected =
    visibleSelectableIds.length > 0 &&
    visibleSelectableIds.every((id) => selectedSet.has(id));
  const someVisibleSelected =
    !allVisibleSelected &&
    visibleSelectableIds.some((id) => selectedSet.has(id));

  const toggleRow = useCallback(
    (id: string) => {
      if (attachedSet.has(id)) return;
      setSelected((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      );
    },
    [attachedSet],
  );

  const handleToggleSelectAll = useCallback(() => {
    setSelected((prev) =>
      toggleSelectAllVisible(prev, visible, alreadyAttached),
    );
  }, [visible, alreadyAttached]);

  const handleAttach = useCallback(async () => {
    if (selected.length === 0 || submitting) return;
    if (!token) {
      toast.error('未登录', '请先登录后再附加录音');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/conversations/${conversationId}/recordings`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ sessionIds: selected }),
        },
      );
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.error) msg = String(body.error);
        } catch {
          /* ignore */
        }
        if (res.status === 404) {
          toast.error('附加失败', '接口暂未就绪，请稍后重试');
        } else {
          toast.error('附加失败', msg);
        }
        setSubmitting(false);
        return;
      }
      onAttached([...selected]);
      setSubmitting(false);
      onClose();
    } catch (err) {
      toast.error(
        '附加失败',
        err instanceof Error ? err.message : '网络异常',
      );
      setSubmitting(false);
    }
  }, [selected, submitting, token, conversationId, onAttached, onClose]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, submitting, onClose]);

  if (!mounted) return null;

  const hasNoRecordings = !loading && items.length === 0 && !loadError;

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center"
        role="dialog"
        aria-modal="true"
        aria-label="附加录音"
      >
        {/* Backdrop with blur */}
        <div
          className={`absolute inset-0 bg-black/30 backdrop-blur-sm ${
            leaving ? 'animate-backdrop-leave' : 'animate-backdrop-enter'
          }`}
          onClick={() => {
            if (!submitting) onClose();
          }}
        />

        {/* Modal card — full-screen on mobile, centered on desktop */}
        <div
          className={`
            relative bg-white shadow-2xl
            w-full h-full sm:h-auto sm:max-w-2xl sm:max-h-[80vh]
            sm:rounded-xl border border-cream-200/60
            flex flex-col overflow-hidden
            ${leaving ? 'animate-modal-leave' : 'animate-modal-enter'}
          `}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-cream-200 bg-gradient-to-r from-rust-50 to-cream-50 shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-rust-500 flex items-center justify-center">
                <Mic className="w-3.5 h-3.5 text-white" />
              </div>
              <div>
                <h2 className="font-serif font-bold text-charcoal-800 text-sm">
                  附加录音 / Attach recording
                </h2>
                <p className="text-[10px] text-charcoal-400">
                  选择已完成的录音，作为对话上下文
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              disabled={submitting}
              aria-label="关闭"
              className="p-1.5 rounded-lg hover:bg-cream-100 text-charcoal-400 hover:text-charcoal-600 transition-colors disabled:opacity-40"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Search + select all */}
          <div className="px-5 py-3 border-b border-cream-200 bg-white shrink-0">
            <div className="relative mb-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-charcoal-300" />
              <input
                type="text"
                value={rawSearch}
                onChange={(e) => setRawSearch(e.target.value)}
                placeholder="搜索标题或课程名…"
                aria-label="搜索"
                className="
                  w-full pl-9 pr-3 py-2 bg-white border border-cream-200 rounded-md
                  text-sm text-charcoal-700 placeholder:text-charcoal-300
                  focus:outline-none focus:border-rust-400 focus:ring-1 focus:ring-rust-200
                "
              />
            </div>
            {/* Select-all visible */}
            <label className="flex items-center gap-2 text-xs text-charcoal-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someVisibleSelected;
                }}
                onChange={handleToggleSelectAll}
                disabled={visibleSelectableIds.length === 0}
                aria-label="全选可见"
                className="accent-rust-500 disabled:opacity-40"
              />
              <span>
                全选可见（{visibleSelectableIds.length}）/ Select all visible
              </span>
            </label>
          </div>

          {/* List */}
          <div
            className="flex-1 overflow-y-auto"
            role="listbox"
            aria-multiselectable="true"
          >
            {loading && (
              <div className="flex items-center justify-center py-12 text-charcoal-400 text-sm gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                加载中…
              </div>
            )}
            {!loading && loadError && (
              <div className="px-5 py-8 text-center text-sm text-red-500">
                加载失败：{loadError}
              </div>
            )}
            {hasNoRecordings && (
              <div className="px-5 py-12 flex flex-col items-center text-center gap-3">
                <FileText className="w-10 h-10 text-charcoal-300" />
                <div className="text-sm text-charcoal-500">
                  暂无完成的录音，去新建一个吧
                </div>
                <Link
                  href="/home"
                  onClick={onClose}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-rust-500 text-white text-xs font-medium hover:bg-rust-600 transition-colors"
                >
                  去新建录音
                </Link>
              </div>
            )}
            {!loading && !loadError && items.length > 0 && visible.length === 0 && (
              <div className="px-5 py-12 text-center text-sm text-charcoal-400">
                没有匹配的录音
              </div>
            )}
            {!loading && visible.length > 0 && (
              <ul className="divide-y divide-cream-100">
                {visible.map((r) => {
                  const isAttached = attachedSet.has(r.id);
                  const isSelected = selectedSet.has(r.id);
                  return (
                    <li
                      key={r.id}
                      role="option"
                      aria-selected={isSelected || isAttached}
                      tabIndex={0}
                      data-testid={`recording-row-${r.id}`}
                      data-attached={isAttached ? 'true' : undefined}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleRow(r.id);
                        }
                      }}
                      onClick={() => toggleRow(r.id)}
                      className={`
                        h-16 px-4 flex items-center gap-3 cursor-pointer
                        transition-colors outline-none
                        focus:bg-cream-50
                        ${
                          isAttached
                            ? 'opacity-60 cursor-default bg-cream-50/50'
                            : isSelected
                              ? 'bg-rust-50 border-l-2 border-rust-200'
                              : 'hover:bg-cream-50'
                        }
                      `}
                    >
                      {/* Checkbox / status */}
                      <div className="shrink-0 w-5 h-5 flex items-center justify-center">
                        {isAttached ? (
                          <div
                            className="w-4 h-4 rounded-sm bg-cream-200 flex items-center justify-center"
                            title="已附加"
                          >
                            <Check className="w-3 h-3 text-charcoal-500" />
                          </div>
                        ) : (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleRow(r.id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`选择 ${r.title}`}
                            className="accent-rust-500"
                          />
                        )}
                      </div>

                      {/* Title + meta */}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-charcoal-800 truncate">
                          {truncate(r.title || '未命名', 50)}
                          {isAttached && (
                            <span className="ml-2 text-[10px] uppercase tracking-wider text-charcoal-400 font-normal">
                              已附加
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 text-[11px] text-charcoal-400">
                          {r.courseName && (
                            <span className="truncate max-w-[140px]">
                              {r.courseName}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="w-3 h-3" />
                            {formatDate(r.createdAt)}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatDuration(r.durationMs)}
                          </span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-cream-200 bg-cream-50 flex items-center justify-end gap-2 shrink-0">
            <button
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 rounded-md text-sm font-medium text-charcoal-600 hover:bg-cream-100 transition-colors disabled:opacity-40"
            >
              取消 / Cancel
            </button>
            <button
              onClick={handleAttach}
              disabled={selected.length === 0 || submitting}
              className="
                px-4 py-2 rounded-md text-sm font-medium
                bg-rust-500 text-white hover:bg-rust-600 active:bg-rust-700
                shadow-sm transition-all
                disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none
                flex items-center gap-2
              "
            >
              {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              附加选中（{selected.length}）/ Attach Selected ({selected.length})
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
