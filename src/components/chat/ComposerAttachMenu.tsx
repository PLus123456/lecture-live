'use client';

/**
 * Composer 左下角的「＋」附件菜单 —— 统一收纳「上传文件 / 上传图片 / 添加录音」三个入口。
 *
 * 取代此前散落在输入框左下的多个独立按钮（图片、回形针、麦克风），
 * 点开后弹出一个小菜单，只渲染父组件真正提供了回调的项。
 * GlobalChat（对话详情）与 ChatTab（上课实时 / 回放）共用。
 */

import { useEffect, useRef, useState } from 'react';
import { Plus, Paperclip, ImagePlus, Mic, Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

interface MenuItem {
  key: string;
  icon: typeof Plus;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
}

export default function ComposerAttachMenu({
  onPickFile,
  onPickImage,
  onAttachRecording,
  supportsImage = false,
  disabled = false,
  uploadingFile = false,
  direction = 'up',
}: {
  /** 上传文件/文档（PDF/Word/PPT/TXT…） */
  onPickFile?: () => void;
  /** 上传图片（仅在模型支持图片输入时可用） */
  onPickImage?: () => void;
  /** 添加录音（挂载已有录音会话） */
  onAttachRecording?: () => void;
  supportsImage?: boolean;
  /** 整体禁用（发送中 / 只读对话等） */
  disabled?: boolean;
  /** 文件上传中：按钮显示 loading */
  uploadingFile?: boolean;
  /** 菜单展开方向：底部 composer 用 up（默认） */
  direction?: 'up' | 'down';
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
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

  const items: MenuItem[] = [];
  if (onPickFile) {
    items.push({ key: 'file', icon: Paperclip, label: t('chat.attachFile'), onClick: onPickFile });
  }
  if (onPickImage) {
    items.push({
      key: 'image',
      icon: ImagePlus,
      label: t('chat.attachImage'),
      onClick: onPickImage,
      disabled: !supportsImage,
      hint: !supportsImage ? t('chat.imageNotSupported') : undefined,
    });
  }
  if (onAttachRecording) {
    items.push({ key: 'recording', icon: Mic, label: t('chat.attachRecording'), onClick: onAttachRecording });
  }

  if (items.length === 0) return null;

  const placement = direction === 'up' ? 'bottom-full mb-2' : 'top-full mt-2';

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={t('chat.attachMenu')}
        aria-label={t('chat.attachMenu')}
        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors
                    disabled:opacity-40 disabled:cursor-not-allowed
                    ${
                      open
                        ? 'bg-cream-100 text-charcoal-600'
                        : 'text-charcoal-400 hover:bg-cream-100 hover:text-charcoal-600'
                    }`}
      >
        {uploadingFile ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Plus className={`w-4 h-4 transition-transform duration-200 ${open ? 'rotate-45' : ''}`} />
        )}
      </button>

      {open && (
        <div
          className={`absolute ${placement} left-0 w-40 bg-white border border-cream-300
                      rounded-lg shadow-lg z-50 py-1 animate-fade-in-scale`}
        >
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <button
                key={it.key}
                type="button"
                disabled={it.disabled}
                title={it.hint}
                onClick={() => {
                  if (it.disabled) return;
                  setOpen(false);
                  it.onClick();
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left transition-colors
                  ${
                    it.disabled
                      ? 'text-charcoal-300 cursor-not-allowed'
                      : 'text-charcoal-600 hover:bg-cream-50'
                  }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="truncate">{it.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
