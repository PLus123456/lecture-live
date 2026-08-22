// src/lib/liveShare/viewer.ts
// 观看者端：连接到分享 session

import { io, Socket } from 'socket.io-client';
import type {
  StreamingPreviewText,
  StreamingPreviewTranslation,
} from '@/types/transcript';

export interface LiveShareTranslationMeta {
  sourceLang?: string | null;
  targetLang?: string | null;
  translationMode?: string | null;
}

/**
 * M2：观众端连接态。此前本类只注册业务事件，WS 不可达 / Origin 被拒
 * （server/websocket.ts 的 io.use）/ 每 IP 连接数超限时既不报错也不重试提示，
 * 观看页的 loading spinner 会永久悬挂。四态含义：
 * - connecting   ：首次握手中（尚未拿到任何 initial_state）；
 * - connected    ：已连上并已 join；
 * - reconnecting ：断了但 socket.io 仍在自动重连（主播瞬断/网络抖动的常态）；
 * - closed       ：不会再自己回来了 —— 服务端主动踢（撤销/过期驱逐走的就是
 *                  disconnect(true)）、或握手被中间件拒绝。
 */
export type ViewerConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

export interface ViewerCallbacks {
  onInitialState: (snapshot: {
    segments: unknown[];
    translations: Record<string, string>;
    summaryBlocks: unknown[];
    status?: string | null;
    previewText?: StreamingPreviewText;
    previewTranslation?: StreamingPreviewTranslation;
    sourceLang?: string | null;
    targetLang?: string | null;
    translationMode?: string | null;
    /** H1：主播端因体积上限截断过 backlog，本快照不是完整历史。 */
    truncated?: boolean;
  }) => void;
  onTranscriptDelta: (delta: unknown) => void;
  onTranslationDelta: (data: {
    segmentId: string;
    translation: string;
    sourceLang?: string;
    targetLang?: string;
    translationMode?: string;
  }) => void;
  onSummaryUpdate: (block: unknown) => void;
  onStatusUpdate: (data: { status: string }) => void;
  onPreviewUpdate: (data: {
    previewText: StreamingPreviewText;
    previewTranslation: StreamingPreviewTranslation;
  }) => void;
  onError: (error: { message: string }) => void;
  /** M2：连接态变化。不提供时行为与旧版一致（故障静默）。 */
  onConnectionChange?: (
    state: ViewerConnectionState,
    info?: { reason?: string; message?: string }
  ) => void;
}

export class LiveViewer {
  private socket: Socket | null = null;
  /** 调用方主动 disconnect() 之后不再上报连接态（离开页面不是「连接失败」）。 */
  private closedByCaller = false;

  connect(socketUrl: string, shareToken: string, callbacks: ViewerCallbacks) {
    this.socket = io(socketUrl, { withCredentials: true });
    const socket = this.socket;

    const report = (
      state: ViewerConnectionState,
      info?: { reason?: string; message?: string }
    ) => {
      if (this.closedByCaller) return;
      callbacks.onConnectionChange?.(state, info);
    };

    report('connecting');

    socket.on('connect', () => {
      report('connected');
      socket.emit('join', { shareToken });
    });

    // 接收初始快照
    socket.on('initial_state', callbacks.onInitialState);

    // 实时增量更新
    socket.on('transcript_delta', callbacks.onTranscriptDelta);
    socket.on('translation_delta', callbacks.onTranslationDelta);
    socket.on('summary_update', callbacks.onSummaryUpdate);
    socket.on('status_update', callbacks.onStatusUpdate);
    socket.on('preview_update', callbacks.onPreviewUpdate);

    // 错误
    socket.on('share_error', callbacks.onError);

    // M2：断连/连接失败。socket.active 是 socket.io-client 4.x 判定「还会不会自己
    // 回来」的权威标志（socket.js 的 destroy() 会清掉 subs → active===false）：
    // - 服务端 disconnect(true)（SHARE-REVOKE-001 的撤销驱逐、优雅关停强断）
    //   与握手中间件拒绝（Origin / 每 IP 上限）→ active=false → 终态 closed；
    // - 传输层抖动 / WS 进程重启 → active=true → reconnecting，socket.io 会自己
    //   重连，重连后 'connect' 重新 join，服务端重发全量 initial_state（C6）。
    socket.on('disconnect', (reason: string) => {
      report(socket.active ? 'reconnecting' : 'closed', { reason });
    });

    socket.on('connect_error', (error: Error) => {
      report(socket.active ? 'reconnecting' : 'closed', {
        message: error?.message,
      });
    });
  }

  disconnect() {
    this.closedByCaller = true;
    this.socket?.disconnect();
    this.socket = null;
  }
}
