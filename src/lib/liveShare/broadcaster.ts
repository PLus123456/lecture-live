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
  onError?: (error: { message: string; code?: string }) => void;
}

export interface LiveBroadcasterAuthState {
  token: string | null;
  epoch: number;
  userId: string | null;
  sessionBinding: string | null;
}

interface BroadcasterReauthOptions {
  initial: LiveBroadcasterAuthState;
  getCurrent: () => LiveBroadcasterAuthState;
}

const BROADCASTER_AUTH_LEAF_EXPIRED = 'BROADCASTER_AUTH_LEAF_EXPIRED';

function hasSameAuthBoundary(
  initial: LiveBroadcasterAuthState,
  current: LiveBroadcasterAuthState
): boolean {
  return (
    initial.epoch === current.epoch &&
    initial.userId !== null &&
    initial.userId === current.userId &&
    initial.sessionBinding === current.sessionBinding
  );
}

/**
 * 这里只决定“是否值得发起一次新 strict 握手”，不授予任何权限。最终仍由服务端用
 * 当前 Cookie 的 current leaf 完整鉴权；generic revoke、登出和账号切换从不走此路径。
 */
export function shouldStrictlyReauthenticateBroadcaster(
  errorCode: string | undefined,
  initial: LiveBroadcasterAuthState,
  current: LiveBroadcasterAuthState
): boolean {
  return (
    errorCode === BROADCASTER_AUTH_LEAF_EXPIRED &&
    typeof current.token === 'string' &&
    current.token.length > 0 &&
    hasSameAuthBoundary(initial, current)
  );
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
  // C16/U11：缓存最近一次同步的全量快照，并在底层 socket 每次 'connect'（含自动
  // 重连）时补发一次，保证主播无论怎么抖动，服务端内存里始终是完整历史。
  // 服务端已把 sync_snapshot 监听器提到鉴权之前注册（server.ts），这里的补发是第二道
  // 保险，也是**重连后**对齐服务端的唯一手段（重连的 socket 没有首帧快照）。
  // 关键：增量必须折回本字段，否则补发的是开分享瞬间的旧态（见 foldIntoSnapshot）。
  private lastSnapshot: SnapshotPayload | null = null;
  private pendingStrictReauth = false;
  private intentionallyDisconnected = false;

  constructor(
    socketUrl: string,
    options: {
      sessionId: string;
      token: string;
      shareToken: string;
      callbacks?: BroadcasterCallbacks;
      reauth?: BroadcasterReauthOptions;
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
    this.socket.on('share_error', (error: { message: string; code?: string }) => {
      const currentAuth = options.reauth?.getCurrent();
      if (
        options.reauth &&
        currentAuth &&
        shouldStrictlyReauthenticateBroadcaster(
          error.code,
          options.reauth.initial,
          currentAuth
        )
      ) {
        // 服务端会紧接着发 `io server disconnect`。在 disconnect 前调用 connect 是
        // no-op，所以这里只挂一次意图，真正重握手放到下面的 disconnect handler。
        this.pendingStrictReauth = true;
        return;
      }
      this.pendingStrictReauth = false;
      options.callbacks?.onError?.(error);
    });

    this.socket.on('disconnect', (reason) => {
      if (
        reason !== 'io server disconnect' ||
        !this.pendingStrictReauth ||
        this.intentionallyDisconnected ||
        !options.reauth
      ) {
        this.pendingStrictReauth = false;
        return;
      }

      const currentAuth = options.reauth.getCurrent();
      this.pendingStrictReauth = false;
      if (
        !shouldStrictlyReauthenticateBroadcaster(
          BROADCASTER_AUTH_LEAF_EXPIRED,
          options.reauth.initial,
          currentAuth
        )
      ) {
        return;
      }

      // token 通常仍是 __cookie_session__ sentinel；新权限来自浏览器此刻携带的最新
      // HttpOnly Cookie。更新 auth 后显式 connect，服务端必须重新走 strict current leaf。
      const auth = this.socket.auth;
      this.socket.auth = {
        ...(auth && typeof auth === 'object' ? auth : {}),
        token: currentAuth.token,
      };
      this.socket.connect();
    });

  }

  syncSnapshot(snapshot: SnapshotPayload) {
    // 记住最新快照，供 'connect' 补发；服务端 sync_snapshot 为全量覆盖语义，
    // 重发同一份不会叠加，只会把服务端内存对齐到最新全量状态。
    this.lastSnapshot = snapshot;
    this.socket.emit('sync_snapshot', snapshot);
  }

  /**
   * U11：把增量折回缓存快照。调用方只在开分享那一刻 syncSnapshot 一次，之后全靠
   * 增量；若增量不折回，'connect' 补发的就是「开分享瞬间」的旧快照——而服务端
   * sync_snapshot 是**全量覆盖**语义，主播抖动重连后这份旧快照会把服务端累积的
   * 增量整个抹掉，晚加入的观众只看到残缺 backlog（主播离线 >20s 更是空的）。
   * 与服务端 mergeEventIntoSnapshot 同口径：按 id 原地替换，无则追加。
   *
   * lastSnapshot 为空（尚未 syncSnapshot）时不凭空造一份：残缺快照一旦补发，
   * 反而会覆盖掉服务端从草稿恢复出的完整历史。
   */
  private foldIntoSnapshot(mutate: (snapshot: SnapshotPayload) => void) {
    if (!this.lastSnapshot) return;
    mutate(this.lastSnapshot);
  }

  broadcastTranscriptDelta(delta: TranscriptSegment) {
    this.foldIntoSnapshot((snapshot) => {
      const index = snapshot.segments.findIndex(
        (segment) => segment.id === delta.id
      );
      if (index === -1) {
        snapshot.segments = [...snapshot.segments, delta];
      } else {
        snapshot.segments = snapshot.segments.map((segment, i) =>
          i === index ? delta : segment
        );
      }
    });

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

    this.foldIntoSnapshot((snapshot) => {
      snapshot.translations = {
        ...snapshot.translations,
        [segmentId]: safeTrans,
      };
      if (meta?.sourceLang) snapshot.sourceLang = meta.sourceLang;
      if (meta?.targetLang) snapshot.targetLang = meta.targetLang;
      if (meta?.translationMode) snapshot.translationMode = meta.translationMode;
    });

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
    this.foldIntoSnapshot((snapshot) => {
      // 与服务端 mergeSummaryBlock 一致：优先按 id 匹配，缺 id 时退到 blockIndex
      const index = snapshot.summaryBlocks.findIndex((block) => {
        if (summaryBlock.id && block.id) return block.id === summaryBlock.id;
        if (
          typeof summaryBlock.blockIndex === 'number' &&
          typeof block.blockIndex === 'number'
        ) {
          return block.blockIndex === summaryBlock.blockIndex;
        }
        return false;
      });
      if (index === -1) {
        snapshot.summaryBlocks = [...snapshot.summaryBlocks, summaryBlock];
      } else {
        snapshot.summaryBlocks = snapshot.summaryBlocks.map((block, i) =>
          i === index ? summaryBlock : block
        );
      }
    });

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
    this.foldIntoSnapshot((snapshot) => {
      snapshot.previewText = payload.previewText;
      snapshot.previewTranslation = payload.previewTranslation;
    });

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
    this.foldIntoSnapshot((snapshot) => {
      snapshot.status = status;
    });

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
    this.intentionallyDisconnected = true;
    this.pendingStrictReauth = false;
    this.socket.disconnect();
  }
}
