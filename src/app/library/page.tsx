'use client';

import { useState } from 'react';
import Link from 'next/link';
import Sidebar from '@/components/Sidebar';
import { useI18n } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  Search,
  Plus,
  Clock,
  Globe,
  ArrowRight,
  ChevronDown,
} from 'lucide-react';

const DEMO_COURSES = [
  {
    id: 'course-a',
    name: 'Modern European History',
    code: 'HIST 201',
    sessionCount: 12,
    totalHours: '18.5',
    sessions: [
      {
        id: 'session-12',
        title: 'Session 12: The Collapse of the Soviet Bloc',
        date: 'Mar 12, 2026',
        duration: '0:45',
        sourceLang: 'en',
        targetLang: 'zh',
        status: 'completed' as const,
      },
      {
        id: 'session-11',
        title: 'Session 11: Decolonization and the New World Order',
        date: 'Mar 5, 2026',
        duration: '1:15',
        sourceLang: 'en',
        targetLang: 'zh',
        status: 'completed' as const,
      },
      {
        id: 'session-10',
        title: 'Session 10: World War II and Human Rights',
        date: 'Feb 28, 2026',
        duration: '1:05',
        sourceLang: 'en',
        targetLang: 'zh',
        status: 'completed' as const,
      },
    ],
  },
];

export default function LibraryPage() {
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');

  const filters = [
    t('libraryPage.filterNewest'),
    t('libraryPage.filterLanguageAll'),
    t('libraryPage.filterDurationAny'),
    t('libraryPage.filterStatusAll'),
  ];

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main
        className={`flex-1 transition-all duration-300 ${
          sidebarCollapsed ? 'ml-16' : 'ml-56'
        }`}
      >
        <div className="px-8 py-10">
          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <div>
              <div className="text-[10px] text-charcoal-400 uppercase tracking-widest mb-1">
                {t('libraryPage.title')}
              </div>
              <h1 className="font-serif text-2xl font-bold text-charcoal-800">
                {t('libraryPage.heading')}
              </h1>
            </div>
            <Link
              href="/session/new"
              className="btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {t('libraryPage.newRecording')}
            </Link>
          </div>

          {/* Search + Filters */}
          <div className="flex items-center gap-3 mb-6">
            <div className="flex-1 relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-charcoal-300" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('libraryPage.searchPlaceholder')}
                className="input-field pl-11"
              />
            </div>
            {filters.map((filter) => (
              <button
                key={filter}
                className="btn-ghost text-xs flex items-center gap-1 whitespace-nowrap"
              >
                {filter}
                <ChevronDown className="w-3 h-3" />
              </button>
            ))}
          </div>

          {/* Course sections */}
          {DEMO_COURSES.map((course) => (
            <section key={course.id} className="mb-10">
              <div className="mb-4">
                <h2 className="font-serif text-xl font-bold text-rust-700">
                  {course.code}: {course.name}
                </h2>
                <p className="text-xs text-charcoal-400 mt-1">
                  {t('libraryPage.sessionsAndHours', {
                    sessions: course.sessionCount,
                    hours: course.totalHours,
                  })}
                </p>
              </div>

              <div className="panel-card divide-y divide-cream-200">
                {course.sessions.map((session) => (
                  <Link
                    key={session.id}
                    href={`/session/${session.id}`}
                    className="group flex items-center justify-between px-5 py-4 hover:bg-cream-50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-medium text-charcoal-700 group-hover:text-rust-600 transition-colors truncate">
                        {session.title}
                      </h3>
                      <div className="flex items-center gap-3 mt-1 text-xs text-charcoal-400">
                        <span>{session.date}</span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {session.duration}
                        </span>
                        <span className="flex items-center gap-1">
                          <Globe className="w-3 h-3" />
                          {session.sourceLang.toUpperCase()}
                          {session.targetLang && ` → ${session.targetLang.toUpperCase()}`}
                        </span>
                        <span className="tag-badge text-[10px]">
                          {session.status === 'completed'
                            ? t('libraryPage.completed')
                            : session.status}
                        </span>
                      </div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-charcoal-300 group-hover:text-rust-500 transition-colors flex-shrink-0" />
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
