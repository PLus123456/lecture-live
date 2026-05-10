'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * 把子元素挂到 document.body 下，避免被祖先元素的 transform / filter
 * 等属性创建的 containing block 困住 position: fixed 定位。
 */
export default function ModalPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
