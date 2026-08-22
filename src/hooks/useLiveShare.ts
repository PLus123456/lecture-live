'use client';

import { useCallback } from 'react';
import { useLiveShareStore } from '@/stores/liveShareStore';
import { useAuthStore } from '@/stores/authStore';
import { LiveBroadcaster } from '@/lib/liveShare/broadcaster';
import { LiveViewer } from '@/lib/liveShare/viewer';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001';
let broadcasterInstance: LiveBroadcaster | null = null;
let viewerInstance: LiveViewer | null = null;
/** L1/M2：当前正在广播的 sessionId。broadcaster 的故障回调（share_error /
 *  连接终态）里必须能撤销对应的 ShareLink，否则 DB 里 isLive 一直是 true，
 *  留下一个「显示在线、实则冻结」的僵尸链接。 */
let broadcastingSessionId: string | null = null;

/**
 * 撤销/降级分享链接。与 stopSharing 走同一个 DELETE，永不抛错：
 * 撤销失败最多留一个僵尸链接，不该把调用方（停止录制 / 故障收尾）一起拖挂。
 */
async function revokeShareLink(
  sessionId: string,
  options?: { keepForPlayback?: boolean }
) {
  const token = useAuthStore.getState().token;
  if (!token) return;

  await fetch('/api/share/create', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      sessionId,
      ...(options?.keepForPlayback && { keepForPlayback: true }),
    }),
  }).catch(() => undefined);
}

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

      // 故障收尾：只对**当前**这一份 broadcaster 生效。回调是异步触发的，主播可能
      // 已经停播并重新开播，此时旧实例的迟到回调绝不能去撤新链接。
      let created: LiveBroadcaster | null = null;
      const teardown = (reason: string) => {
        if (!created || created !== broadcasterInstance) return;
        const failedSessionId = broadcastingSessionId;
        broadcasterInstance?.disconnect();
        broadcasterInstance = null;
        broadcastingSessionId = null;
        reset();
        // L1：此前这里只重置本地 UI，DB 里 ShareLink.isLive 仍为 true —— 分享列表
        // 与公开链接都显示「直播中」，实际早已没有主播在推流。撤销才是真结束。
        if (failedSessionId) {
          void revokeShareLink(failedSessionId);
        }
        console.warn(`[liveShare] live broadcast torn down (${reason})`);
      };

      created = new LiveBroadcaster(WS_URL, {
        sessionId,
        token,
        shareToken: data.token,
        callbacks: {
          onViewerCount: (count) => setViewerCount(count),
          onError: () => teardown('share_error'),
          // M2：连接终态（服务端踢人 / Origin 或 IP 上限被中间件拒 / 超过重连
          // 期限仍未回来）。此前两端都没有任何 connect_error / disconnect 监听，
          // 主播 UI 会在 WS 进程崩溃后继续显示「直播中」并静默丢数据。
          // 只有 'closed' 才收尾：'reconnecting' 属于服务端 15s 主播宽限期内的
          // 常态抖动，收尾会把一次 Wi-Fi 切换升级成「直播被掐断」。
          onConnectionChange: (state, info) => {
            if (state !== 'closed') return;
            teardown(info?.reason ?? info?.message ?? 'connection_closed');
          },
        },
      });
      broadcasterInstance = created;
      broadcastingSessionId = sessionId;
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

    // L2：SHARE_OFFLINE 必须在 DELETE **之前**发。两个原因：
    // ① DELETE 会触发 SHARE-REVOKE-001 的内部通知，服务端随即把观众全部断开
    //    （transition 模式还是静默断开），晚发的状态更新根本没人收得到；
    // ② 未连接时 socket.io-client 会把 emit 塞进 sendBuffer，而紧随其后的
    //    disconnect() 走 destroy() 会把缓冲整个丢掉（4.8.3 源码核实），
    //    所以 broadcastStatusUpdate 内部只在真的连着时才发。
    // 发不出去也不致命：服务端 15s 主播宽限期到点会替我们广播 SHARE_OFFLINE。
    broadcasterInstance?.broadcastStatusUpdate('SHARE_OFFLINE');

    if (activeSessionId) {
      await revokeShareLink(activeSessionId, options);
    }

    broadcasterInstance?.disconnect();
    broadcasterInstance = null;
    broadcastingSessionId = null;
    reset();
  }, [reset]);

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
