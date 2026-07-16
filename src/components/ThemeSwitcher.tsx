'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useTheme, type Theme } from '@/components/ThemeProvider';

interface ThemeSwitcherProps {
  variant?: 'button' | 'segmented';
  className?: string;
  showLabels?: boolean;
}

const options: Array<{ value: Theme; icon: typeof Sun; labelKey: string }> = [
  { value: 'light', icon: Sun, labelKey: 'settings.themeLight' },
  { value: 'dark', icon: Moon, labelKey: 'settings.themeDark' },
  { value: 'system', icon: Monitor, labelKey: 'settings.themeSystem' },
];

export default function ThemeSwitcher({
  variant = 'button',
  className = '',
  showLabels = true,
}: ThemeSwitcherProps) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { t } = useI18n();

  if (variant === 'button') {
    const nextTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
    const Icon = resolvedTheme === 'dark' ? Sun : Moon;
    const label = resolvedTheme === 'dark'
      ? t('settings.switchToLight')
      : t('settings.switchToDark');

    return (
      <button
        type="button"
        onClick={() => setTheme(nextTheme)}
        className={`group inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-cream-200 bg-white text-charcoal-400 shadow-sm transition-all hover:border-cream-300 hover:bg-cream-100 hover:text-charcoal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rust-400 focus-visible:ring-offset-2 dark:border-charcoal-700 dark:bg-charcoal-800 dark:text-cream-400 dark:hover:border-charcoal-600 dark:hover:bg-charcoal-700 dark:hover:text-cream-100 dark:focus-visible:ring-offset-charcoal-900 ${className}`}
        aria-label={label}
        title={label}
      >
        <Icon className="h-4 w-4 transition-transform duration-200 group-hover:rotate-12" aria-hidden="true" />
      </button>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label={t('settings.colorTheme')}
      className={`grid grid-cols-3 gap-1 rounded-xl border border-cream-200 bg-cream-100 p-1 dark:border-charcoal-700 dark:bg-charcoal-900/70 ${className}`}
    >
      {options.map(({ value, icon: Icon, labelKey }) => {
        const selected = theme === value;
        const label = t(labelKey);
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(value)}
            className={`flex min-w-0 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rust-400 ${
              selected
                ? 'bg-white text-charcoal-800 shadow-sm ring-1 ring-cream-200 dark:bg-charcoal-700 dark:text-cream-100 dark:ring-charcoal-600'
                : 'text-charcoal-500 hover:bg-white/60 hover:text-charcoal-700 dark:text-charcoal-300 dark:hover:bg-charcoal-800 dark:hover:text-cream-200'
            }`}
            title={label}
          >
            <Icon className={`h-4 w-4 flex-shrink-0 ${selected ? 'text-rust-500 dark:text-rust-400' : ''}`} aria-hidden="true" />
            {showLabels ? <span className="truncate">{label}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
