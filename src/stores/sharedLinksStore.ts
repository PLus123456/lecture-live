'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
    }),
    {
      name: 'lecture-live-viewed-share-links',
    }
  )
);
