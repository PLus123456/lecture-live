'use client';

import { createContext, useContext } from 'react';
import en from './locales/en';
import zh from './locales/zh';

export type Locale = 'en' | 'zh';

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
