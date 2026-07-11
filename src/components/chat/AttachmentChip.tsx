'use client';

import { FileText, ImageIcon, X } from 'lucide-react';
import { formatBytes } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

/**
 * Chat 输入区下方展示「已上传」附件的小芯片。
 *
 * 与 `pendingImages`（仅本地 base64）不同：这里持有的是后端
 * /api/chat-uploads 已经成功落盘的附件元数据。`previewUrl`
 * 可选 —— Cloudreve 直连预览 URL；没有就单击不响应。
 */
export interface AttachmentChipData {
  id: string;
  fileName: string;
  /** 字节数；BigInt 序列化后是 number/string，统一接收 number。 */
  bytes: number;
  /** 'image' | 'document' | 'text' */
  kind: 'image' | 'document' | 'text';
  /** 可选预览链接；没有则点击无效果。 */
  previewUrl?: string;
}

function truncate(name: string, max = 20): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot < max - 4) {
    return `${name.slice(0, max - 1)}…`;
  }
  const ext = name.slice(dot);
  const headLen = Math.max(1, max - 1 - ext.length);
  return `${name.slice(0, headLen)}…${ext}`;
}

export default function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: AttachmentChipData;
  onRemove?: (id: string) => void;
}) {
  const { t } = useI18n();
  const Icon = attachment.kind === 'image' ? ImageIcon : FileText;
  const displayName = truncate(attachment.fileName, 20);
  const sizeLabel = formatBytes(attachment.bytes);

  // 文件名按钮：有预览 URL → 新页打开 Cloudreve；否则禁用，单击无响应
  const NameNode = attachment.previewUrl ? (
    <a
      href={attachment.previewUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="truncate hover:underline"
      title={attachment.fileName}
    >
      {displayName}
    </a>
  ) : (
    <span className="truncate" title={attachment.fileName}>
      {displayName}
    </span>
  );

  return (
    <div
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-cream-300
                 bg-cream-50 text-[11px] text-charcoal-600 max-w-[220px] animate-tag-pop"
    >
      <Icon className="w-3.5 h-3.5 text-charcoal-400 flex-shrink-0" />
      {NameNode}
      <span className="text-charcoal-400 flex-shrink-0">· {sizeLabel}</span>
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(attachment.id)}
          className="ml-0.5 w-4 h-4 rounded hover:bg-charcoal-100 text-charcoal-400
                     hover:text-charcoal-700 flex items-center justify-center flex-shrink-0"
          title={t('chat.removeAttachment')}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
