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
}

export class LiveBroadcaster {
  private socket: Socket;
  private sessionId: string;

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

    this.socket.on('viewer_count', (payload: { count: number }) => {
      options.callbacks?.onViewerCount?.(payload.count);
    });
    this.socket.on('share_error', (error: { message: string }) => {
      options.callbacks?.onError?.(error);
    });
  }

  syncSnapshot(snapshot: SnapshotPayload) {
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

  broadcastTranslationDelta(segmentId: string, translation: string) {
    this.socket.emit('broadcast', {
      sessionId: this.sessionId,
      event: {
        type: 'translation_delta',
        payload: { segmentId, translation },
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
