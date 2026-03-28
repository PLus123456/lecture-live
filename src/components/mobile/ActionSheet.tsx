'use client';

import BottomSheet from '@/components/mobile/BottomSheet';

export interface ActionSheetItem {
  key: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface ActionSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  items: ActionSheetItem[];
}

export default function ActionSheet({
  open,
  onClose,
  title,
  items,
}: ActionSheetProps) {
  return (
    <BottomSheet open={open} onClose={onClose} title={title} maxHeight="70vh">
      <div className="space-y-2 pb-2">
        {items.map((item) => (
          <button
            key={item.key}
            onClick={() => {
              if (item.disabled) {
                return;
              }
              item.onSelect();
              onClose();
            }}
            disabled={item.disabled}
            className={`flex w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-colors ${
              item.disabled
                ? 'cursor-not-allowed border-cream-200 bg-cream-50 text-charcoal-300'
                : item.danger
                  ? 'border-red-200 bg-red-50 text-red-700'
                  : 'border-cream-200 bg-white text-charcoal-700 hover:bg-cream-50'
            }`}
          >
            {item.icon ? (
              <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-cream-100 text-current">
                {item.icon}
              </span>
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{item.label}</span>
              {item.description ? (
                <span className="mt-1 block text-xs text-charcoal-400">{item.description}</span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
    </BottomSheet>
  );
}
