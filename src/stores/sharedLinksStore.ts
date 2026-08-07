'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** persist 的 localStorage key。登出清扫需要按名字兜底删一次，故导出。 */
export const SHARED_LINKS_STORAGE_KEY = 'lecture-live-viewed-share-links';

export interface ViewedShareLink {
  token: string;
  url: string;
  sessionId: string;
  title: string;
  sourceLang: string;
  targetLang: string;
  status: string;
  viewedAt: string;
}

interface SharedLinksStore {
  viewedLinks: ViewedShareLink[];
  rememberViewedLink: (link: ViewedShareLink) => void;
  removeViewedLink: (token: string) => void;
  /** 登出时清空（C47/L27）：分享 token 落 localStorage 是有意功能，但不该跨账号留在本机。 */
  clearViewedLinks: () => void;
}

export const useSharedLinksStore = create<SharedLinksStore>()(
  persist(
    (set) => ({
      viewedLinks: [],
      rememberViewedLink: (link) =>
        set((state) => {
          const deduped = state.viewedLinks.filter((entry) => entry.token !== link.token);
          return {
            viewedLinks: [link, ...deduped].slice(0, 20),
          };
        }),
      removeViewedLink: (token) =>
        set((state) => ({
          viewedLinks: state.viewedLinks.filter((entry) => entry.token !== token),
        })),
      clearViewedLinks: () => set({ viewedLinks: [] }),
    }),
    {
      name: SHARED_LINKS_STORAGE_KEY,
    }
  )
);
