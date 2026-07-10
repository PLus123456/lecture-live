import { headers } from 'next/headers';
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n';

/**
 * 服务端 UI 语言检测（用于 SSR 首屏 & metadata）。
 * 优先级：浏览器 Accept-Language（命中支持列表）→ 站点默认语言 → 'en'。
 * 与客户端 I18nProvider 的浏览器检测保持一致，让首屏尽量贴近访客，
 * 客户端再据 localStorage 精修（返回访客的显式偏好）。
 */
export async function detectServerLocale(
  siteDefaultLanguage?: string | null
): Promise<Locale> {
  const fallback: Locale =
    siteDefaultLanguage === 'zh' || siteDefaultLanguage === 'en'
      ? (siteDefaultLanguage as Locale)
      : 'en';

  try {
    const headerList = await headers();
    const acceptLanguage = headerList.get('accept-language');
    if (!acceptLanguage) return fallback;

    // 解析 "zh-CN,zh;q=0.9,en;q=0.8" → 按 q 权重排序的语言标签
    const tags = acceptLanguage
      .split(',')
      .map((part) => {
        const [tag, ...params] = part.trim().split(';');
        const qParam = params.find((p) => p.trim().startsWith('q='));
        const q = qParam ? parseFloat(qParam.split('=')[1]) : 1;
        return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
      })
      .filter((entry) => entry.tag.length > 0)
      .sort((a, b) => b.q - a.q);

    for (const { tag } of tags) {
      if ((SUPPORTED_LOCALES as readonly string[]).includes(tag)) {
        return tag as Locale;
      }
      const prefix = tag.split('-')[0];
      if ((SUPPORTED_LOCALES as readonly string[]).includes(prefix)) {
        return prefix as Locale;
      }
    }
  } catch {
    // headers() 不可用时回落
  }

  return fallback;
}
