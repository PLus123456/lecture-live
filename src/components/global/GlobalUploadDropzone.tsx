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
      dragCounterRef.current = 0;
      setDragActive(false);

      const file = e.dataTransfer?.files?.[0];
      if (!file) return;

      if (!ACCEPTED_MEDIA_RE.test(file.type)) {
        // 非音视频文件忽略，让用户没有打扰感
        // 也可以选择 toast 提示，但拖入图片这种很常见，提示太烦
        return;
      }

      if (file.size > MAX_BYTES_FALLBACK) {
        // 提示后端限制是动态的；这里只防止特别大的文件
        // 真正的精确限制在创建 session 后由 upload API 检查
        return;
      }

      setPendingFile(file);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [enabled]);

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
      {dragActive && (
        <ModalPortal>
          <div
            className="fixed inset-0 z-[1500] flex items-center justify-center pointer-events-none"
            aria-hidden
          >
            <div className="absolute inset-0 bg-rust-500/8 backdrop-blur-[2px]" />
            <div className="relative flex flex-col items-center gap-4 rounded-3xl border-4 border-dashed border-rust-400 bg-white/90 px-12 py-10 shadow-2xl">
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
