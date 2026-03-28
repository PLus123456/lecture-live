'use client';

import { useEffect, useState } from 'react';

export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) {
      return;
    }

    const viewport = window.visualViewport;
    const update = () => {
      const nextHeight = Math.max(0, window.innerHeight - viewport.height);
      setHeight(nextHeight > 80 ? nextHeight : 0);
    };

    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);

    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);

  return height;
}
