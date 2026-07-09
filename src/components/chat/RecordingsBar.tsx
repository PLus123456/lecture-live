'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Mic, X, Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

/**
 * 顶栏录音 pill 数据结构 —— 后端 `/api/conversations/[id]/recordings`
 * 当前仅返回 { sessionId, title, addedAt }。
 *
 * U56：曾有 durationMs / transcriptPreview 两个可选字段，但后端 listRecordings 从不返回、
 * 客户端也不回填，pill 时长恒显示「--」、popover 正文恒显示「...」，是死 UI。
 * 后端拓宽响应属另一批（recordings route 不在本批文件范围），这里先移除这两块死字段/死 UI，
 * 待后端补齐字段时再一并恢复。
 */
export interface RecordingPill {
  sessionId: string;
  title: string;
  /** true = 对话的来源录音（legacy sessionId 绑定），常驻挂载、不显示移除按钮 */
  legacy?: boolean;
}

/**
 * GlobalChat 顶部的「已挂载录音」一行 pills + 添加按钮。
 *
 * - 没挂任何录音：显示空态 + 添加按钮（点击后弹出 RecordingPicker，U11）。
 * - 有挂载：每条录音一个 pill，X 移除（DELETE 子路由 U9）。
 *   点击 pill 主体 → 展开下方 popover 显示 transcript 预览（点击外部关闭）。
 *
 * 后端 API 不可用时静默兜底：onAttach 和 onDetach 被父组件传入，
 * 父组件负责 try/catch + toast 反馈；本组件只渲染 UI。
 */
export default function RecordingsBar({
  recordings,
  onAttach,
  onDetach,
  attachDisabled = false,
}: {
  recordings: RecordingPill[];
  onAttach?: () => void;
  onDetach?: (sessionId: string) => void;
  /** picker 还未就绪（U11 未合并）时禁用「添加录音」按钮 */
  attachDisabled?: boolean;
}) {
  const { t } = useI18n();
  const [openId, setOpenId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 打开预览 popover 时：点击组件外部或按 Esc 关闭（与 ChatTab/GlobalChat 菜单一致）。
  useEffect(() => {
    if (!openId) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpenId(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenId(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openId]);

  return (
    <div ref={containerRef} className="border-b border-cream-200 bg-cream-50/60">
      <div className="flex items-center gap-2 px-4 py-2 flex-wrap">
        {recordings.length === 0 ? (
          <span className="text-[11px] text-charcoal-400 italic">
            {t('chat.noRecordings')}
          </span>
        ) : (
          recordings.map((r) => {
            const isOpen = openId === r.sessionId;
            return (
              <div key={r.sessionId} className="relative">
                <div
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md
                              text-[11px] border transition-colors
                              ${
                                isOpen
                                  ? 'bg-rust-50 border-rust-300 text-rust-700'
                                  : 'bg-white border-cream-300 text-charcoal-600 hover:border-cream-400'
                              }`}
                >
                  <button
                    type="button"
                    onClick={() => setOpenId(isOpen ? null : r.sessionId)}
                    className="flex items-center gap-1.5 max-w-[200px]"
                    title={r.title}
                  >
                    <Mic className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate">{r.title}</span>
                  </button>
                  {/* 来源录音（legacy）常驻，不给移除按钮（服务端 DELETE 也会 400 拒绝） */}
                  {onDetach && !r.legacy && (
                    <button
                      type="button"
                      onClick={() => onDetach(r.sessionId)}
                      className="w-4 h-4 rounded hover:bg-charcoal-100 text-charcoal-400
                                 hover:text-charcoal-700 flex items-center justify-center"
                      title={t('chat.removeRecording')}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
                {isOpen && (
                  <div
                    className="absolute top-full left-0 mt-1 w-72 max-w-[80vw] bg-white border border-cream-300
                               rounded-lg shadow-lg p-3 text-[11px] z-30 animate-fade-in-scale"
                  >
                    <div className="font-medium text-charcoal-800 mb-2 truncate">
                      {r.title}
                    </div>
                    <Link
                      href={`/session/${r.sessionId}/playback`}
                      className="text-rust-500 hover:text-rust-700 underline"
                    >
                      Open recording →
                    </Link>
                  </div>
                )}
              </div>
            );
          })
        )}

        <button
          type="button"
          onClick={() => onAttach?.()}
          disabled={attachDisabled || !onAttach}
          title={
            attachDisabled
              ? t('chat.recordingPickerComingSoon')
              : t('chat.attachRecording')
          }
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md
                     border border-dashed border-cream-400 text-[11px] text-charcoal-500
                     hover:border-rust-300 hover:text-rust-600 transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="w-3 h-3" />
          {t('chat.attachRecording')}
        </button>
      </div>
    </div>
  );
}
