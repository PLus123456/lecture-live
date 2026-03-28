'use client';

import { getFlagUrl, getFlagUrlByLang, getFlagUrlByRegion } from '@/lib/flags';

/**
 * 跨平台国旗图片组件
 * 替代 Unicode emoji 国旗，在 Windows 上也能正确显示
 */
export default function FlagImg({
  code,
  type = 'country',
  size = 16,
  className = '',
}: {
  /** 代码：国家代码 / 语言代码 / 区域代码 */
  code: string;
  /** 类型：country=国家代码, lang=语言代码, region=数据中心区域 */
  type?: 'country' | 'lang' | 'region';
  /** 显示尺寸 (px)，默认 16 */
  size?: number;
  className?: string;
}) {
  const cdnWidth = size <= 20 ? 20 : size <= 40 ? 40 : 80;
  const url =
    type === 'lang'
      ? getFlagUrlByLang(code, cdnWidth)
      : type === 'region'
        ? getFlagUrlByRegion(code, cdnWidth)
        : getFlagUrl(code, cdnWidth);

  return (
    <img
      src={url}
      alt={code.toUpperCase()}
      width={size}
      height={Math.round(size * 0.75)}
      className={`inline-block object-cover rounded-[2px] ${className}`}
      style={{ width: size, height: Math.round(size * 0.75) }}
      loading="lazy"
      decoding="async"
    />
  );
}
