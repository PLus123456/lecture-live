'use client';

/**
 * OriginGuard — 前端域名二进制校验组件
 *
 * 从 /api/site-config 获取 site_url 和 site_url_alt，
 * 将允许的 origin 和当前 window.location.origin 编码为 UTF-8 字节序列，
 * 逐字节比较（"二进制体操"），不匹配则显示 403 拒绝页面。
 */

import { useEffect, useState } from 'react';

type GuardState = 'loading' | 'pass' | 'blocked';

// 将字符串编码为 Uint8Array（UTF-8 字节）
function toBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

// 从 URL 字符串中提取 origin（protocol + host），忽略尾部斜杠和路径
function extractOrigin(url: string): string {
  try {
    const parsed = new URL(url.trim());
    return parsed.origin; // e.g. "https://example.com"
  } catch {
    return '';
  }
}

// 逐字节比较两段 UTF-8 数据
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // 使用异或运算做常量时间比较，防止时间侧信道
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export default function OriginGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, setState] = useState<GuardState>('loading');

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch('/api/site-config');
        if (!res.ok) {
          // 配置加载失败，放行（避免因后端问题锁住全站）
          if (!cancelled) setState('pass');
          return;
        }
        const data = await res.json();

        const siteUrl: string = data.site_url ?? '';
        const siteUrlAlt: string = data.site_url_alt ?? '';

        // 如果管理员没有配置任何 URL，放行
        if (!siteUrl.trim() && !siteUrlAlt.trim()) {
          if (!cancelled) setState('pass');
          return;
        }

        const currentOriginBytes = toBytes(window.location.origin.toLowerCase());

        const allowedOrigins: string[] = [];
        if (siteUrl.trim()) allowedOrigins.push(extractOrigin(siteUrl));
        if (siteUrlAlt.trim()) allowedOrigins.push(extractOrigin(siteUrlAlt));

        const matched = allowedOrigins.some((origin) => {
          if (!origin) return false;
          const allowedBytes = toBytes(origin.toLowerCase());
          return bytesEqual(currentOriginBytes, allowedBytes);
        });

        if (!cancelled) {
          setState(matched ? 'pass' : 'blocked');
        }
      } catch {
        // 网络错误放行
        if (!cancelled) setState('pass');
      }
    }

    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'loading') {
    // 加载时什么都不渲染，避免闪烁
    return null;
  }

  if (state === 'blocked') {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-cream-50">
        <div className="text-center max-w-md px-6">
          <div className="text-6xl font-bold text-charcoal-300 mb-4">403</div>
          <h1 className="text-xl font-semibold text-charcoal-700 mb-2">
            访问被拒绝
          </h1>
          <p className="text-sm text-charcoal-400">
            当前访问地址不在允许的站点列表中，请通过正确的域名访问。
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
