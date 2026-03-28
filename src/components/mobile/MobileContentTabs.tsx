'use client';

import { Languages, MessageSquareText, NotebookText, Sparkles, Tags } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export type MobileTab = 'transcript' | 'translation' | 'summary' | 'chat' | 'keywords';

interface MobileContentTabsProps {
  activeTab: MobileTab;
  onChange: (tab: MobileTab) => void;
  hasTranslation: boolean;
}

export default function MobileContentTabs({
  activeTab,
  onChange,
  hasTranslation,
}: MobileContentTabsProps) {
  const { t } = useI18n();
  const tabs: Array<{ key: MobileTab; label: string; icon: React.ReactNode }> = [
    { key: 'transcript', label: t('viewer.tabsTranscript'), icon: <NotebookText className="h-4 w-4" /> },
    { key: 'translation', label: t('viewer.tabsTranslation'), icon: <Languages className="h-4 w-4" /> },
    { key: 'summary', label: t('viewer.tabsSummary'), icon: <Sparkles className="h-4 w-4" /> },
    { key: 'chat', label: t('mobile.ai'), icon: <MessageSquareText className="h-4 w-4" /> },
    { key: 'keywords', label: t('mobile.keywords'), icon: <Tags className="h-4 w-4" /> },
  ];

  return (
    <div className="border-t border-cream-200 bg-white/95 backdrop-blur-md">
      <div className="mobile-scroll flex items-stretch overflow-x-auto px-2">
        {tabs.filter((tab) => hasTranslation || tab.key !== 'translation').map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => onChange(tab.key)}
              className={`flex min-w-[72px] flex-1 flex-col items-center justify-center gap-1 border-b-2 px-3 py-2 text-[11px] font-medium transition-colors ${
                active
                  ? 'border-rust-500 text-rust-600'
                  : 'border-transparent text-charcoal-400'
              }`}
            >
              {tab.icon}
              <span className="whitespace-nowrap">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
