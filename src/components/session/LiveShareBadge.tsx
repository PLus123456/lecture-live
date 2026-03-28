'use client';

import { useLiveShareStore } from '@/stores/liveShareStore';
import { useI18n } from '@/lib/i18n';
import { Radio, Eye } from 'lucide-react';

export default function LiveShareBadge() {
  const { isSharing, viewerCount, isViewing } = useLiveShareStore();
  const { t } = useI18n();

  if (isViewing) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-200">
        <Eye className="w-3 h-3 text-blue-500" />
        <span className="text-[11px] text-blue-600 font-medium">{t('liveShare.viewingLive')}</span>
      </div>
    );
  }

  if (!isSharing) return null;

  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-50 border border-red-200">
      <Radio className="w-3 h-3 text-red-500 animate-pulse" />
      <span className="text-[11px] text-red-600 font-medium">
        {viewerCount === 1
          ? t('liveShare.liveSingle', { n: viewerCount })
          : t('liveShare.liveMultiple', { n: viewerCount })}
      </span>
    </div>
  );
}
