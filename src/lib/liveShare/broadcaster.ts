// src/lib/liveShare/broadcaster.ts
// 录制者端：将实时数据广播给观看者

import { io, Socket } from 'socket.io-client';
import type { TranscriptSegment } from '@/types/transcript';
import type { SummaryBlock } from '@/types/summary';
import type {
  StreamingPreviewText,
  StreamingPreviewTranslation,
} from '@/types/transcript';

interface BroadcasterCallbacks {
  onViewerCount?: (count: number) => void;
  onError?: (error: { message: string }) => void;
}

interface SnapshotPayload {
  segments: TranscriptSegment[];
  translations: Record<string, string>;
  summaryBlocks: SummaryBlock[];
  status: string;
  previewText: StreamingPreviewText;
  previewTranslation: StreamingPreviewTranslation;
  sourceLang?: string;
  targetLang?: string;
  translationMode?: string;
}

export class LiveBroadcaster {
  private socket: Socket;
  private sessionId: string;
  // C16/U11：缓存最近一次同步的全量快照。直播中途开分享时，服务端的 sync_snapshot
  // 监听器要等 await authenticateBroadcaster 之后才注册；若首帧快照在监听器就位前
  // 到达会被丢弃，导致晚加入观众丢失开分享前的全部转录/摘要。故在底层 socket 每次
  // 'connect'（含自动重连）触发时，若已有缓存快照则补发一次，保证监听器无论注册多晚、
  // 无论是否重连，主播都会在连上后向服务端补齐全量快照。
  private lastSnapshot: SnapshotPayload | null = null;

  constructor(
    socketUrl: string,
    options: {
      sessionId: string;
      token: string;
      shareToken: string;
      callbacks?: BroadcasterCallbacks;
    }
  ) {
    this.sessionId = options.sessionId;
    this.socket = io(socketUrl, {
      withCredentials: true,
      auth: {
        token: options.token,
        sessionId: options.sessionId,
        shareToken: options.shareToken,
      },
    });

    // C16/U11：连上（含重连）后补发最近一次快照。socket.io-client 在每次成功建立
    // 连接时都会触发 'connect'，此处只在有缓存时重发，不重复叠加历史。
    this.socket.on('connect', () => {
      if (this.lastSnapshot) {
        this.socket.emit('sync_snapshot', this.lastSnapshot);
      }
    });

    this.socket.on('viewer_count', (payload: { count: number }) => {
      options.callbacks?.onViewerCount?.(payload.count);
    });
    this.socket.on('share_error', (error: { message: string }) => {
      options.callbacks?.onError?.(error);
    });
  }

  syncSnapshot(snapshot: SnapshotPayload) {
    // 记住最新快照，供 'connect' 补发；服务端 sync_snapshot 为全量覆盖语义，
    // 重发同一份不会叠加，只会把服务端内存对齐到最新全量状态。
    this.lastSnapshot = snapshot;
    this.socket.emit('sync_snapshot', snapshot);
  }

  broadcastTranscriptDelta(delta: Partial<TranscriptSegment>) {
    this.socket.emit('broadcast', {
      sessionId: this.sessionId,
      event: {
        type: 'transcript_delta',
        payload: delta,
        timestamp: Date.now(),
      },
    });
  }

  broadcastTranslationDelta(
    segmentId: string,
    translation: string,
    meta?: { sourceLang?: string; targetLang?: string; translationMode?: string }
  ) {
    const MAX_TRANSLATION_LENGTH = 10_000;
    const safeTrans = translation.length > MAX_TRANSLATION_LENGTH
      ? translation.slice(0, MAX_TRANSLATION_LENGTH)
      : translation;

    this.socket.emit('broadcast', {
      sessionId: this.sessionId,
      event: {
        type: 'translation_delta',
        payload: { segmentId, translation: safeTrans, ...meta },
        timestamp: Date.now(),
      },
    });
  }

  broadcastSummaryUpdate(summaryBlock: SummaryBlock) {
    this.socket.emit('broadcast', {
      sessionId: this.sessionId,
      event: {
        type: 'summary_update',
        payload: summaryBlock,
        timestamp: Date.now(),
      },
    });
  }

  /** 广播实时预览文本（正在说的内容，尚未确认为完整段落） */
  broadcastPreviewUpdate(payload: {
    previewText: StreamingPreviewText;
    previewTranslation: StreamingPreviewTranslation;
  }) {
    this.socket.emit('broadcast', {
      sessionId: this.sessionId,
      event: {
        type: 'preview_update',
        payload,
        timestamp: Date.now(),
      },
    });
  }

  broadcastStatusUpdate(status: string) {
    this.socket.emit('broadcast', {
      sessionId: this.sessionId,
      event: {
        type: 'status_update',
        payload: { status },
        timestamp: Date.now(),
      },
    });
  }

  disconnect() {
    this.socket.disconnect();
  }
}
