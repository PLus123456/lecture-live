'use client';

import { useCallback } from 'react';
import { useLiveShareStore } from '@/stores/liveShareStore';
import { useAuthStore } from '@/stores/authStore';
import { LiveBroadcaster } from '@/lib/liveShare/broadcaster';
import { LiveViewer } from '@/lib/liveShare/viewer';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001';
let broadcasterInstance: LiveBroadcaster | null = null;
let viewerInstance: LiveViewer | null = null;

export function useLiveShare() {
  // 使用独立 selector 避免每次渲染创建新对象导致无限循环
  const isSharing = useLiveShareStore((s) => s.isSharing);
  const shareToken = useLiveShareStore((s) => s.shareToken);
  const viewerCount = useLiveShareStore((s) => s.viewerCount);
  const isViewing = useLiveShareStore((s) => s.isViewing);
  const setSharing = useLiveShareStore((s) => s.setSharing);
  const setViewerCount = useLiveShareStore((s) => s.setViewerCount);
  const setViewing = useLiveShareStore((s) => s.setViewing);
  const reset = useLiveShareStore((s) => s.reset);
  const token = useAuthStore((s) => s.token);

  /** 录制者：创建分享链接并开始广播 */
  const startSharing = useCallback(
    async (sessionId: string) => {
      if (!token) return null;

      const res = await fetch('/api/share/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ sessionId, isLive: true }),
      });

      if (!res.ok) throw new Error('Failed to create share link');
      const data = await res.json();

      broadcasterInstance?.disconnect();
      broadcasterInstance = new LiveBroadcaster(WS_URL, {
        sessionId,
        token,
        shareToken: data.token,
        callbacks: {
          onViewerCount: (count) => setViewerCount(count),
          onError: () => {
            broadcasterInstance?.disconnect();
            reset();
            broadcasterInstance = null;
          },
        },
      });
      setSharing(true, data.token);

      return data;
    },
    [token, setViewerCount, reset, setSharing]
  );

  /** 录制者：停止分享
   *  @param options.keepForPlayback 保留链接供回放（录制结束时使用），默认完全撤销
   */
  const stopSharing = useCallback(async (
    sessionId?: string,
    options?: { keepForPlayback?: boolean },
  ) => {
    const activeSessionId = sessionId;
    if (token && activeSessionId) {
      await fetch('/api/share/create', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          sessionId: activeSessionId,
          ...(options?.keepForPlayback && { keepForPlayback: true }),
        }),
      }).catch(() => undefined);
    }
    broadcasterInstance?.broadcastStatusUpdate('SHARE_OFFLINE');
    broadcasterInstance?.disconnect();
    broadcasterInstance = null;
    reset();
  }, [reset, token]);

  /** 观看者：连接到分享 session */
  const joinAsViewer = useCallback(
    (viewerShareToken: string, callbacks: Parameters<LiveViewer['connect']>[2]) => {
      viewerInstance?.disconnect();
      viewerInstance = new LiveViewer();
      viewerInstance.connect(WS_URL, viewerShareToken, callbacks);
      setViewing(true);
    },
    [setViewing]
  );

  /** 观看者：断开连接 */
  const leaveAsViewer = useCallback(() => {
    viewerInstance?.disconnect();
    viewerInstance = null;
    setViewing(false);
  }, [setViewing]);

  return {
    isSharing,
    shareToken,
    viewerCount,
    isViewing,
    setSharing,
    setViewerCount,
    setViewing,
    reset,
    broadcaster: broadcasterInstance,
    startSharing,
    stopSharing,
    joinAsViewer,
    leaveAsViewer,
  };
}
