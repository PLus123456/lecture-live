'use client';

import { create } from 'zustand';

interface LiveShareStore {
  isSharing: boolean;
  shareToken: string | null;
  viewerCount: number;
  isViewing: boolean; // true when current user is a viewer

  setSharing: (sharing: boolean, token?: string) => void;
  setViewerCount: (count: number) => void;
  setViewing: (viewing: boolean) => void;
  reset: () => void;
}

export const useLiveShareStore = create<LiveShareStore>((set) => ({
  isSharing: false,
  shareToken: null,
  viewerCount: 0,
  isViewing: false,

  setSharing: (isSharing, shareToken) =>
    set({ isSharing, shareToken: shareToken ?? null }),

  setViewerCount: (viewerCount) => set({ viewerCount }),

  setViewing: (isViewing) => set({ isViewing }),

  reset: () =>
    set({
      isSharing: false,
      shareToken: null,
      viewerCount: 0,
      isViewing: false,
    }),
}));
