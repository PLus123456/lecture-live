'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useSwipeGesture } from '@/hooks/useSwipeGesture';

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  maxHeight?: string;
}

export default function BottomSheet({
  open,
  onClose,
  title,
  children,
  maxHeight = '85vh',
}: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);

  useSwipeGesture(sheetRef, {
    onSwipeDown: onClose,
    threshold: 56,
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[70]">
      <button
        aria-label="Close sheet"
        className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-backdrop-enter"
        onClick={onClose}
      />
      <div className="absolute inset-x-0 bottom-0 flex justify-center">
        <div
          ref={sheetRef}
          className="w-full rounded-t-2xl bg-white shadow-2xl transition-transform duration-300 ease-out"
          style={{ maxHeight }}
        >
          <div className="flex items-center justify-between border-b border-cream-200 px-4 pb-3 pt-2">
            <div className="flex-1">
              <div className="mx-auto mb-2 h-1.5 w-12 rounded-full bg-cream-300" />
              {title ? (
                <h2 className="text-sm font-semibold text-charcoal-800">{title}</h2>
              ) : (
                <div className="h-5" />
              )}
            </div>
            <button
              onClick={onClose}
              className="ml-3 flex h-8 w-8 items-center justify-center rounded-full text-charcoal-400 transition-colors hover:bg-cream-100 hover:text-charcoal-700"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mobile-scroll overflow-y-auto px-4 pb-4 safe-bottom">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
