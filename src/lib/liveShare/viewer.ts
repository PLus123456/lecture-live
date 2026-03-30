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
}

export class LiveViewer {
  private socket: Socket | null = null;

  connect(socketUrl: string, shareToken: string, callbacks: ViewerCallbacks) {
    this.socket = io(socketUrl, { withCredentials: true });

    this.socket.on('connect', () => {
      this.socket?.emit('join', { shareToken });
    });

    // 接收初始快照
    this.socket.on('initial_state', callbacks.onInitialState);

    // 实时增量更新
    this.socket.on('transcript_delta', callbacks.onTranscriptDelta);
    this.socket.on('translation_delta', callbacks.onTranslationDelta);
    this.socket.on('summary_update', callbacks.onSummaryUpdate);
    this.socket.on('status_update', callbacks.onStatusUpdate);
    this.socket.on('preview_update', callbacks.onPreviewUpdate);

    // 错误
    this.socket.on('share_error', callbacks.onError);
  }

  disconnect() {
    this.socket?.disconnect();
    this.socket = null;
  }
}
