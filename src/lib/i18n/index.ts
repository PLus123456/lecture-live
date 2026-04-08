'use client';

import { createContext, useContext } from 'react';
import en from './locales/en';
import zh from './locales/zh';

export type Locale = 'en' | 'zh';

/** 支持的 UI 语言列表 — 新增语言只需在此添加 */
export const SUPPORTED_LOCALES: Locale[] = ['en', 'zh'];

/** 语言选择器选项 */
export const UI_LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
];

/**
 * 根据浏览器语言偏好自动检测 UI 语言。
 * 遍历 navigator.languages，优先精确匹配，再做前缀匹配（如 zh-CN → zh）。
 * 都不命中则返回 fallback。
 */
export function detectBrowserLocale(fallback: Locale = 'en'): Locale {
  if (typeof window === 'undefined') return fallback;
  const browserLangs =
    navigator.languages?.length > 0
      ? navigator.languages
      : navigator.language
        ? [navigator.language]
        : [];
  for (const lang of browserLangs) {
    const lower = lang.toLowerCase();
    // 精确匹配
    if (SUPPORTED_LOCALES.includes(lower as Locale)) return lower as Locale;
    // 前缀匹配 (e.g. zh-CN → zh)
    const prefix = lower.split('-')[0];
    if (SUPPORTED_LOCALES.includes(prefix as Locale)) return prefix as Locale;
  }
  return fallback;
}

// 递归将所有 leaf 值类型放宽为 string，使 zh 可以赋给 en 的结构
type DeepStringify<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringify<T[K]>;
};

type TranslationObject = DeepStringify<typeof en>;

const translations: Record<Locale, TranslationObject> = { en, zh };

// 用 dot notation 获取嵌套翻译值
// t('auth.signIn') → 'Sign In'
// t('home.daysAgo', { n: 3 }) → '3 days ago'
export function getTranslation(locale: Locale) {
  const dict = translations[locale] || translations.en;

  function t(key: string, params?: Record<string, string | number>): string {
    const keys = key.split('.');
    let value: unknown = dict;
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = (value as Record<string, unknown>)[k];
      } else {
        return key; // fallback to key
      }
    }
    if (typeof value !== 'string') return key;

    // 替换 {param} 占位符
    if (params) {
      return value.replace(/\{(\w+)\}/g, (_, p) =>
        params[p] !== undefined ? String(params[p]) : `{${p}}`
      );
    }
    return value;
  }

  return t;
}

// Context
interface I18nContextValue {
  locale: Locale;
  t: ReturnType<typeof getTranslation>;
  setLocale: (locale: Locale) => void;
}

export const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  t: getTranslation('en'),
  setLocale: () => {},
});

export function useI18n() {
  return useContext(I18nContext);
}

export { en, zh };
export type { TranslationObject };
