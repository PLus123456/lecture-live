'use client';

import { useState } from 'react';
import { Sparkles, MessageSquare, Tag } from 'lucide-react';
import SummaryTab from './SummaryTab';
import ChatTab from './ChatTab';
import KeywordTab from './KeywordTab';

type Tab = 'summary' | 'chat' | 'keyword';

export default function AiPanel({
  onManualSummary,
  onInjectKeywords,
}: {
  onManualSummary?: () => void;
  onInjectKeywords?: (keywords: string[]) => Promise<void> | void;
}) {
  const [activeTab, setActiveTab] = useState<Tab>('summary');

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'summary', label: 'Summary', icon: <Sparkles className="w-3.5 h-3.5" /> },
    { key: 'chat', label: 'Chat', icon: <MessageSquare className="w-3.5 h-3.5" /> },
    { key: 'keyword', label: 'Keywords', icon: <Tag className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="panel-card flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-cream-200">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors
              ${
                activeTab === tab.key
                  ? 'text-rust-600 border-b-2 border-rust-500 bg-rust-50/50'
                  : 'text-charcoal-400 hover:text-charcoal-600 hover:bg-cream-50'
              }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'summary' && <SummaryTab onManualTrigger={onManualSummary} />}
        {activeTab === 'chat' && <ChatTab onInjectKeywords={onInjectKeywords} />}
        {activeTab === 'keyword' && <KeywordTab onInjectKeywords={onInjectKeywords} />}
      </div>
    </div>
  );
}
