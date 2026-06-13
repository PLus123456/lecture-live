'use client';

/**
 * 全站文件拖拽上传 + 转录入口。
 *
 * 工作流：
 * 1. 监听 window dragenter/over/leave/drop，拖入文件时显示半透明 overlay。
 * 2. 用户松手 → 弹 UploadTranscribeModal，让用户配置语言、文件夹。
 * 3. 用户点开始：创建 session → 上传 audio → 浏览器内 Soniox 转录 → 持久化 → finalize。
 * 4. 任务跑起来后用户可"最小化"，modal 消失，任务挂在 uploadJobsStore 里继续跑。
 * 5. 完成后弹 toast，点击跳转 /session/[id]/playback。
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Upload as UploadIcon } from 'lucide-react';
import ModalPortal from '@/components/ModalPortal';
import UploadTranscribeModal from './UploadTranscribeModal';
import { useAuthStore } from '@/stores/authStore';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/toastStore';
import { useExitAnimation } from '@/hooks/useExitAnimation';

const ACCEPTED_MEDIA_RE = /^(audio|video)\//i;
// 5GB —— async file API 走分片上传 + 后端 ffmpeg 抽音频，远高于老路径的 500MB。
// Soniox 单文件音频时长上限是 5 小时（不是字节）；5GB 足以覆盖一段 5 小时 1080p mp4。
const MAX_BYTES_FALLBACK = 5 * 1024 * 1024 * 1024;

export default function GlobalUploadDropzone() {
  const [dragActive, setDragActive] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const dragCounterRef = useRef(0);
  const router = useRouter();
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const { t } = useI18n();

  // 拖拽 overlay 的进入/离场两段式动画（dragActive 为布尔，无 retain-during-leave 崩溃风险）。
  const { mounted: overlayMounted, leaving: overlayLeaving } = useExitAnimation(dragActive, 150);

  // 在登录/公开分享观看/setup 等页面禁用全站拖拽（避免在公开页面误触发，
  // 也避免已登录用户访问他人分享链接时误触发上传流程）
  const enabled = Boolean(
    user &&
    pathname &&
    !pathname.startsWith('/login') &&
    !pathname.startsWith('/register') &&
    !pathname.startsWith('/setup') &&
    !pathname.startsWith('/privacy') &&
    !pathname.startsWith('/terms') &&
    !/^\/session\/[^/]+\/view(\/|$)/.test(pathname)
  );

  useEffect(() => {
    if (!enabled) return;

    const isFileDrag = (e: DragEvent) => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      // Chrome 用 'Files'，Safari 早期版本可能略不同
      return Array.from(types).some((t) => t === 'Files' || t === 'application/x-moz-file');
    };

    const resetDragState = () => {
      dragCounterRef.current = 0;
      setDragActive(false);
    };

    const onDragEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragCounterRef.current += 1;
      setDragActive(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) setDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      resetDragState();

      const file = e.dataTransfer?.files?.[0];
      if (!file) return;

      if (!ACCEPTED_MEDIA_RE.test(file.type)) {
        // 图片/文档拖到页面很常见（用户在拖错位置），静默忽略以免烦扰。
        // 但对明显意图是媒体文件（type 为空 = 浏览器不识别）的情况，告知用户为什么没反应。
        const isLikelyAccidentalDrop =
          /^(image|text|application)\//i.test(file.type);
        if (!isLikelyAccidentalDrop) {
          toast.error(t('upload.invalidFileType'));
        }
        return;
      }

      if (file.size > MAX_BYTES_FALLBACK) {
        toast.error(
          t('upload.fileTooLarge', { max: Math.floor(MAX_BYTES_FALLBACK / (1024 * 1024)) })
        );
        return;
      }

      setPendingFile(file);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    // 拖出窗口边界 / 切换标签页 / 拖拽中点 ESC：dragLeave 可能不成对触发，
    // 计数器会卡住导致 overlay 不消失或下次拖入失灵。这几个事件做兜底 reset。
    window.addEventListener('dragend', resetDragState);
    window.addEventListener('blur', resetDragState);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', resetDragState);
      window.removeEventListener('blur', resetDragState);
    };
  }, [enabled, t]);

  const handleClose = useCallback(() => {
    setPendingFile(null);
  }, []);

  const handleNavigate = useCallback(
    (sessionId: string) => {
      router.push(`/session/${sessionId}/playback`);
    },
    [router]
  );

  if (!enabled) return null;

  return (
    <>
      {/* 拖拽 overlay */}
      {overlayMounted && (
        <ModalPortal>
          <div
            className="fixed inset-0 z-[1500] flex items-center justify-center pointer-events-none"
            aria-hidden
          >
            <div
              className={`absolute inset-0 bg-rust-500/8 backdrop-blur-[2px] ${
                overlayLeaving ? 'animate-backdrop-leave' : 'animate-backdrop-enter'
              }`}
            />
            <div
              className={`relative flex flex-col items-center gap-4 rounded-3xl border-4 border-dashed border-rust-400 bg-white/90 px-12 py-10 shadow-2xl ${
                overlayLeaving ? 'animate-fade-out-scale' : 'animate-fade-in-scale'
              }`}
            >
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-rust-500 shadow-lg shadow-rust-500/30">
                <UploadIcon className="h-8 w-8 text-white" />
              </div>
              <div className="text-center">
                <div className="font-serif text-xl font-bold text-charcoal-800">
                  {t('upload.overlayTitle')}
                </div>
                <div className="mt-1 text-xs text-charcoal-400">
                  {t('upload.overlayHint')}
                </div>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}

      {/* 配置 + 进度 modal */}
      {pendingFile && (
        <UploadTranscribeModal
          file={pendingFile}
          onClose={handleClose}
          onNavigate={handleNavigate}
        />
      )}
    </>
  );
}
