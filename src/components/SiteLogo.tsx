'use client';

import { useEffect, useState } from 'react';
import { BookOpen } from 'lucide-react';

/** 缓存 logo 路径，避免重复请求 */
let cachedLogoPath: string | null = null;

/**
 * 站点 Logo 组件 — 如果管理员上传了自定义 logo 则显示图片，否则回退到默认图标。
 * @param size - 图标容器尺寸 class（如 "w-8 h-8"）
 * @param iconSize - 内部 lucide 图标尺寸 class（如 "w-4 h-4"）
 */
export default function SiteLogo({
  size = 'w-8 h-8',
  iconSize = 'w-4 h-4',
  className = '',
}: {
  size?: string;
  iconSize?: string;
  className?: string;
}) {
  const [logoPath, setLogoPath] = useState(cachedLogoPath);

  useEffect(() => {
    if (cachedLogoPath !== null) return;
    fetch('/api/site-config')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const path = data?.logo_path?.trim() || '';
        cachedLogoPath = path;
        setLogoPath(path);
      })
      .catch(() => {
        cachedLogoPath = '';
        setLogoPath('');
      });
  }, []);

  if (logoPath) {
    return (
      <div className={`${size} rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden ${className}`}>
        <img src={logoPath} alt="Logo" className="w-full h-full object-contain" />
      </div>
    );
  }

  return (
    <div className={`${size} bg-gradient-to-br from-rust-500 to-rust-600 rounded-lg flex items-center justify-center flex-shrink-0 shadow-sm ${className}`}>
      <BookOpen className={`${iconSize} text-white`} />
    </div>
  );
}
