'use client';

import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  type: ToastType;
  message: string;
  description?: string;
  /** 自动关闭延迟（毫秒）。0 表示需要手动关闭 */
  duration: number;
}

interface ToastStore {
  toasts: Toast[];
  show: (input: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => number;
  success: (message: string, description?: string) => number;
  error: (message: string, description?: string) => number;
  info: (message: string, description?: string) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

let counter = 0;
const nextId = () => {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return counter;
};

const DEFAULT_DURATION = 3000;
const ERROR_DURATION = 5000;

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],

  show: ({ type, message, description, duration }) => {
    const id = nextId();
    const finalDuration =
      duration ?? (type === 'error' ? ERROR_DURATION : DEFAULT_DURATION);
    set((state) => ({
      toasts: [...state.toasts, { id, type, message, description, duration: finalDuration }],
    }));
    if (finalDuration > 0) {
      setTimeout(() => get().dismiss(id), finalDuration);
    }
    return id;
  },

  success: (message, description) =>
    get().show({ type: 'success', message, description }),

  error: (message, description) =>
    get().show({ type: 'error', message, description }),

  info: (message, description) =>
    get().show({ type: 'info', message, description }),

  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  clear: () => set({ toasts: [] }),
}));

/**
 * 全局便捷调用，无需在组件中订阅 store。
 * 不会触发组件重渲染 — 仅用于发送 toast。
 *
 * 用法：
 *   import { toast } from '@/stores/toastStore';
 *   toast.success('已保存');
 *   toast.error('保存失败', '请检查网络连接');
 */
export const toast = {
  success: (message: string, description?: string) =>
    useToastStore.getState().success(message, description),
  error: (message: string, description?: string) =>
    useToastStore.getState().error(message, description),
  info: (message: string, description?: string) =>
    useToastStore.getState().info(message, description),
  show: (input: Omit<Toast, 'id' | 'duration'> & { duration?: number }) =>
    useToastStore.getState().show(input),
  dismiss: (id: number) => useToastStore.getState().dismiss(id),
};
