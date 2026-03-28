/**
 * 跨平台国旗解决方案
 * Windows 不支持 Unicode 国旗 emoji，统一使用 CDN 图片
 * CDN: https://flagcdn.com
 */

/** 语言代码 → 国家代码（用于国旗图片） */
export const LANG_TO_COUNTRY: Record<string, string> = {
  en: 'us',
  zh: 'cn',
  ja: 'jp',
  ko: 'kr',
  fr: 'fr',
  de: 'de',
  es: 'es',
  pt: 'br',
  it: 'it',
  ru: 'ru',
  ar: 'sa',
  hi: 'in',
  th: 'th',
  vi: 'vn',
  id: 'id',
  tr: 'tr',
  pl: 'pl',
  nl: 'nl',
  sv: 'se',
  da: 'dk',
  fi: 'fi',
  no: 'no',
  uk: 'ua',
  cs: 'cz',
  ro: 'ro',
  hu: 'hu',
  el: 'gr',
  bg: 'bg',
  he: 'il',
  ms: 'my',
  tl: 'ph',
};

/** 数据中心区域代码 → 国旗国家代码 */
export const REGION_TO_COUNTRY: Record<string, string> = {
  us: 'us',
  eu: 'eu', // flagcdn.com 支持 EU 旗
  jp: 'jp',
};

/**
 * 获取国旗图片 URL
 * @param countryCode 国家/地区代码（小写），如 'us', 'cn', 'eu'
 * @param width 图片宽度 (px)，默认 20
 */
export function getFlagUrl(countryCode: string, width: number = 20): string {
  return `https://flagcdn.com/w${width}/${countryCode.toLowerCase()}.png`;
}

/**
 * 通过语言代码获取国旗 URL
 */
export function getFlagUrlByLang(langCode: string, width: number = 20): string {
  const country = LANG_TO_COUNTRY[langCode] || langCode;
  return getFlagUrl(country, width);
}

/**
 * 通过数据中心区域获取国旗 URL
 */
export function getFlagUrlByRegion(region: string, width: number = 20): string {
  const country = REGION_TO_COUNTRY[region] || region;
  return getFlagUrl(country, width);
}
